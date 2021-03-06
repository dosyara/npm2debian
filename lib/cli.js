var Q = require('q'),
    QFS = require('q-io/fs'),
    CP = require('child_process'),
    FS = require('fs'),
    PATH = require('path'),
    SYS = require('util'),
    NPM = require('npm'),
    SEMVER = require('semver');

BIN = {
    'debchange': 'debchange',
    'dh_make': 'dh_make'
};

exports.main = function () {

    var pkgJson = JSON.parse(FS.readFileSync(PATH.resolve(__dirname, '../package.json')));

    require('coa').Cmd()
        .name(PATH.basename(process.argv[1]))
        .title(pkgJson.description)
        .helpful()
        .opt()
            .name('output').title('Output directory')
            .short('o').long('output')
            .def(process.cwd())
            .end()
        .opt()
            .name('versioned').title('Build versioned debian package')
            .long('versioned')
            .flag()
            .end()
        .opt()
            .name('maintainer').title('Debian package maintainer name')
            .short('m').long('maintainer')
            .def(process.env.DEBFULLNAME)
            .end()
        .opt()
            .name('email').title('Debian package maintainer email')
            .short('e').long('email')
            .def(process.env.EMAIL)
            .end()
        .opt()
            .name('packagePrefix').title('Debian package name prefix')
            .short('p').long('package-prefix')
            .def('npm-')
            .end()
        .opt()
            .name('noPackagePrefix').title('Do not add prefix to Debian package name')
            .long('no-package-prefix')
            .flag()
            .end()
        .opt()
            .name('debVersion').title('Debian package version')
            .short('u').long('debian-version')
            .end()
        .opt()
            .name('debBuild').title('Debian package build')
            .short('b').long('debian-build')
            .def('1')
            .end()
        .opt()
            .name('version').title('Show version')
            .short('v').long('version')
            .flag()
            .only()
            .act(function() {
                return pkgJson.version;
            })
            .end()
        .arg()
            .name('pkg').title('Package')
            .arr()
            .req()
            .end()
        .completable()
        .act(function(opts, args) {

            return loadConf({cache: PATH.resolve('.cache')})
                .then(function() {
                    console.log('versioned = %s', opts.versioned);
                    console.log('bin = %s', NPM.bin);
                    console.log('dir = %s', NPM.dir);
                    console.log('cache = %s', NPM.cache);
                    console.log('tmp = %s', NPM.tmp);
                    console.log('binaries = %s', SYS.inspect(BIN));

                    return args.pkg.reduce(function(done, pkg) {
                        return Q.all([done, debianize(pkg, opts)]).get(0);
                    }, undefined);
                });

        })
        .run();

};

var loadConf = function(conf) {
    var d = Q.defer();
    NPM.load(conf, function(err) {
        err? d.reject(err) : d.resolve();
    });
    return d.promise;
};

var npmInstall = function(where, pkg) {
    if(!pkg) {
        pkg = where;
        where = null;
    }
    console.log('npmInstall: %s, %j', where, pkg);
    var d = Q.defer();
    NPM.commands.install(where, pkg, function(err, data) {
        err? d.reject(err) : d.resolve(data);
    });
    return d.promise;
};

var cacheAdd = function(pkg) {
    console.log('cacheAdd: %s', pkg);
    var d = Q.defer();
    NPM.commands.cache.add(pkg, function(err, data) {
        err? d.reject(err) : d.resolve(data);
    });
    return d.promise;
};

var cacheRead = function(pkg, ver, forceBypass) {
    console.log('cacheRead: %s-%s', pkg, ver);
    var d = Q.defer();
    NPM.commands.cache.read(pkg, ver, forceBypass, function(err, data) {
        err? d.reject(err) : d.resolve(data);
    });
    return d.promise;
};

var cacheUnpack = function(pkg, ver, targetPath) {
    console.log('cacheUnpack: %s-%s', pkg, ver);
    var d = Q.defer();
    NPM.commands.cache.unpack(pkg, ver, targetPath, function(err) {
        err? d.reject(err) : d.resolve();
    });
    return d.promise;
};

var debianize = function(pkg, opts) {
    console.log('debianize: %s', pkg);
    return cacheAdd(pkg)
        .then(function(data) {
            return makeSourcePackage(data.name, data.version, opts);
        });
};

var makeSourcePackage = function(pkg, ver, opts) {
    var ctx = {};

    // populate context from args and opts
    ctx.pkg = pkg;
    ctx.ver = ver;
    ctx.versioned = opts.versioned;
    ctx.arch = 'all'; // TODO: support 'all' and 'any'
    ctx.maintainer = opts.maintainer;
    ctx.email = opts.email;
    ctx.debianNamePrefix = opts.noPackagePrefix ? '' : opts.packagePrefix;
    ctx.debianVersionBuild = opts.debBuild;
    ctx.debianVersion = opts.debVersion || ver + '-' + ctx.debianVersionBuild;
    ctx.debianNameSuffix = '-' + ver.replace(/\./g, '-');
    ctx.debianName = ctx.debianNamePrefix + pkg;
    ctx.debianNameVersioned = ctx.debianName + ctx.debianNameSuffix;

    var debianPackageDir = PATH.join(opts.output, ctx.debianName + '-' + ver),
        debianDir = PATH.join(debianPackageDir, 'debian');

    return QFS.exists(debianPackageDir)
        .then(function(exists) {
            if (exists) {
                return rimraf(debianPackageDir);
            }
        })
        .then(function() {

            return cacheUnpack(pkg, ver, debianPackageDir)
                .then(function() {
                    return npmInstall(debianPackageDir, []);
                })
                .then(function() {
                    return cacheRead(pkg, ver);
                })
                .then(function(packageData) {

                    ctx.packageData = packageData;
                    ctx.shortdesc = packageData.description || '';
                    ctx.longdesc = 'This is a debianized npm package';

                    var cleanPackages = [],
                        deps = packageData.dependencies || {},
                        devDeps = packageData.devDependencies || {},
                        bundleDeps = packageData.bundledDependencies || [],
                        filter = function(key) {
                            return bundleDeps.indexOf(key) === -1;
                        };

                    console.log('deps = %j', deps);
                    console.log('devDeps = %j', devDeps);
                    console.log('bundleDeps = %j', bundleDeps);

                    cleanPackages = cleanPackages.concat(filterObjectKeys(deps, filter), filterObjectKeys(devDeps, filter));
                    console.log('cleanPackages = %j', cleanPackages);
                    if (cleanPackages.length) ctx.cleanCmd = 'npm uninstall ' + cleanPackages.join(' ');

                    var nodeVer, npmVer;
                    try {
                        nodeVer = packageData.engines.node;
                    } catch(ignore) {}
                    try {
                        npmVer = packageData.engines.npm;
                    } catch(ignore) {}

                    ctx.depends = semverToDebian('nodejs', nodeVer);
                    ctx.buildDepends = semverToDebian('npm', npmVer);

                })
                .then(function() {
                    return dh_make(debianPackageDir, ctx);
                })
                .then(function() {
                    return dch(debianPackageDir, ctx.debianName, ctx.debianVersion, 'Release of ' + pkg + ' ' + ver);
                })
                .then(function() {
                    var n2d = ctx.packageData.npm2debian;
                    if(n2d && n2d['bash-completion']) {
                        return generateBashCompletion(debianPackageDir, n2d['bash-completion'], ctx);
                    }
                })
                .then(function() {
                    return Q.all([
                        tplDebianFile(PATH.join(debianDir, 'control'), ctx),
                        tplDebianFile(PATH.join(debianDir, 'rules'), ctx),
                        tplDebianFile(PATH.join(debianDir, 'install'), ctx),
                        tplDebianFile(PATH.join(debianDir, 'links'), ctx)
                    ]);
                });

        });
};

var filterObjectKeys = function(obj, cb) {
    cb = cb || function() {
        return true;
    };
    var keys = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key) || !cb(key, obj)) continue;
        keys.push(key);
    }
    return keys;
};

var generateBashCompletion = function(dir, comps, ctx) {
    // generate debian/install for etc/bash_completion.d/*
    ctx.install = 'etc/bash_completion.d/*  etc/bash_completion.d';

    var compPath = PATH.resolve(dir, 'etc/bash_completion.d');

    // create etc/bash_completion.d dir
    return mkdir(compPath)
        .then(function() {
            // generate completions scripts to etc/bash_completion.d
            var done;
            for (var bin in comps) {
                done = Q.all([done, saveBashCompletionScript(dir, PATH.join(compPath, bin), comps[bin])]).get(0);
            }
            return done;
        });
};

var saveBashCompletionScript = function(dir, path, comp) {
    if(!comp.script) {
        return Q.resolve();
    }

    return Q.fcall(function() {
            var d = Q.defer(),
                opts = { cwd: dir, env: process.env };

            CP.exec(comp.script, opts, function(err, stdout, stderr) {
                err? d.reject(err) : d.resolve(stdout);
            });

            console.log(comp.script);

            return d.promise;
        })
        .then(function(content) {
            return QFS.write(path, content, { charset: 'utf8' });
        });
};

var dh_make = function(dir, ctx) {
    var d = Q.defer(),
        tplDir = ctx.versioned? 'debian-npm-ver' : 'debian-npm',
        cmd = [
            BIN.dh_make,
            //'--cdbs',
            '--defaultless',
            '--templates', PATH.resolve(__dirname, '..', tplDir),
            '--packagename', ctx.debianName,
            //'--copyright', 'gpl', // TODO
            '--createorig',
            '--file', PATH.resolve(NPM.cache, ctx.pkg, ctx.ver, 'package.tgz')
        ].join(' '),
        opts = { cwd: dir, env: process.env };

    console.log(cmd);

    var child = CP.exec(cmd, opts, function(err, stdout, stderr) {
        err? d.reject(err) : d.resolve();
    });
    child.stdin.write('\n');

    return d.promise;
};

var dch = function(dir, pkg, ver, text) {
    var d = Q.defer(),
        cmd = [
            BIN.debchange,
            '--create',
            '--empty',
            '--package', pkg,
            '--newversion', ver,
            '--distribution', 'unstable',
            '--force-distribution',
            '"' + text + '"'
        ].join(' '),
        opts = { cwd: dir, env: process.env };

    console.log(cmd);

    CP.exec(cmd, opts, function(err, stdout, stderr) {
        err? d.reject(err) : d.resolve();
    });

    return d.promise;
};

var rimraf = function(path) {
    var d = Q.defer();
    require('rimraf')(path, function(err) {
        err? d.reject(err) : d.resolve();
    });
    return d.promise;
};

var mkdir = function(ensure, mode, uid, gid, noChmod) {
    var d = Q.defer();
    require('npm/lib/utils/mkdir-p')(ensure, mode || '0777', uid, gid, noChmod, function(err) {
        err? d.reject(err) : d.resolve();
    });
    return d.promise;
};

var tplDebianFile = function(path, ctx) {
    return Q.when(QFS.read(path, { charset: 'utf8' }), function(tpl) {
        console.log('tplDebianFile: %s', path);
        return QFS.write(path, parseTemplate(tpl, ctx), { charset: 'utf8' });
    });
};

var parseTemplate = function(template, vars) {
    return (Array.isArray(template)? template.join('\n') + '\n' : template)
        .replace(/\${\s*([^\s:}]*)\s*}/gi, function(s, varName){
            return (vars || {})[varName] || '';
        });
};

var semverToDebian = function(pkg, ver) {
    if(!ver) return pkg;

    var comparators = SEMVER.Range(ver, true).set,
        deps = [];

    comparators.forEach(function(comp) {

        comp.forEach(function(edge) {
            // strip leading "-0"
            edge = edge.value.replace(/-0$/, '');

            if(!edge) {
                deps.push(pkg);
            } else {
                edge = edge
                    .replace(/^(\d)/, '= $1')
                    .replace(/^(<|>)(\d)/, '$1$1 $2')
                    .replace(/^(>=|<=)/, '$1 ');
                deps.push(pkg + ' (' + edge + ')');
            }
        });
    });

    return deps.join(' | ');
};
