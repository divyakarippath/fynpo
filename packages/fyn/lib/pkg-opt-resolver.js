"use strict";

const assert = require("assert");
const Fs = require("fs");
const Path = require("path");
const Tar = require("tar");
const xsh = require("xsh");
const _ = require("lodash");
const Promise = require("bluebird");
const readFile = Promise.promisify(Fs.readFile);
const mkdirp = Promise.promisify(require("mkdirp"));
const PromiseQueue = require("./util/promise-queue");
const logger = require("./logger");
const Inflight = require("./util/inflight");
const LifecycleScripts = require("./lifecycle-scripts");

xsh.Promise = Promise;

//
// resolve optional dependencies
//
// If a package is in optional dep, then it should be:
//
// - the package itself resolved to a version with its meta.
// - queue up for deferred processing until regular dep are all resolved
// - optional packages are fetched and extracted to __fv_
// - execute its preinstall script
// - package that failed is ignore
// - package that passed is added back to the regular resolving pipeline
// - all results saved for logging at the end
// - expect final clean-up to remove any ignored packages
//

class PkgOptResolver {
  constructor(options) {
    this._optPkgCount = 0;
    this._passedPkgs = [];
    this._checkedPkgs = {};
    //
    // for remembering that we've extrated a package by name@version ID
    // to __fv_ dir so we can avoid extrating it later
    //
    this._extractedPkgs = {};
    this._failedPkgs = [];
    this._depResolver = options.depResolver;
    this._inflights = new Inflight();
    this._fyn = options.fyn;
    this._promiseQ = new PromiseQueue({
      concurrency: 2,
      stopOnError: false,
      processItem: x => this.optCheck(x)
    });
    this._promiseQ.on("fail", x => logger.log("opt-check fail", x));
    this._promiseQ.on("failItem", x => logger.log("opt-check failItem", x.error));
  }

  //
  // optDep should contain:
  // - the item for the optional dep
  // - the meta info for the whole package
  //
  add(optDep) {
    this._optPkgCount++;
    this._promiseQ.addItem(optDep, true);
  }

  start() {
    this._promiseQ._process();
  }

  isExtracted(name, version) {
    return this._extractedPkgs[`${name}@${version}`];
  }

  //
  // - check if installed under node_modules
  // - check if installed under __fv_
  // - if none, then fetch tarball and extract to __fv_
  // - run preinstall npm script
  // - check if exit 0 or not
  // - 0: add item back to resolve
  // - not: add item to queue for logging at end
  //
  optCheck(data) {
    const name = data.item.name;
    const version = data.item.resolved;
    const pkgId = `${name}@${version}`;

    const processCheckResult = promise => {
      return promise.then(res => {
        if (res.passed) {
          // exec exit status 0, add to defer resolve queue
          this._passedPkgs.push(data);
        } else {
          // exec failed, add to queue for logging at end
          this._failedPkgs.push({ err: res.err, data });
        }
      });
    };

    // already check in progress
    const inflight = this._inflights.get(pkgId);
    if (inflight) {
      return processCheckResult(inflight);
    }

    // already check completed, just use existing result
    if (this._checkedPkgs[pkgId]) {
      return processCheckResult(Promise.resolve(this._checkedPkgs[pkgId]));
    }

    const checkPkg = path => {
      return readFile(Path.join(path, "package.json"))
        .then(JSON.parse)
        .then(pkg => pkg.version === version && { path, pkg });
    };

    let installedPath = this._fyn.getInstalledPkgDir(name, version, { promoted: true });
    // is it under node_modules/<name> and has the right version?
    const promise = checkPkg(installedPath)
      .catch(() => {
        // is it under node_modules/<name>/__fv_/<version>?
        installedPath = this._fyn.getInstalledPkgDir(name, version, { promoted: false });
        return checkPkg(installedPath);
      })
      .catch(() => {
        if (this._fyn.regenOnly) {
          //
          // regen only, don't bother fetching anything
          //
          return "regenOnlyFail";
        }

        const dist = data.meta.versions[version].dist;
        // none found, fetch tarball
        return this._fyn.pkgSrcMgr
          .fetchTarball({ name, version, dist })
          .tap(() => mkdirp(installedPath))
          .then(res => {
            // extract tarball to node_modules/<name>/__fv_/<version>
            const tarXOpt = { file: res.fullTgzFile, strip: 1, strict: true, C: installedPath };
            return Promise.try(() => Tar.x(tarXOpt))
              .then(() => checkPkg(installedPath))
              .catch(err => {
                logger.log(
                  "opt-resolver: reading package.json from package extracted from",
                  res.fullTgzFile,
                  "failed."
                );
                throw err;
              })
              .tap(x => {
                assert(
                  x,
                  `opt-resolver: version of package in ${installedPath} extracted from ${
                    res.fullTgzFile
                  } didn't match ${version}!`
                );
                this._extractedPkgs[pkgId] = installedPath;
              });
          });
      })
      .then(res => {
        if (res === "regenOnlyFail") {
          logger.log(`optional check ${pkgId} regen only optional false - auto failed`);
          return { passed: false };
        }
        // run npm script `preinstall`
        const checked = _.get(res, "pkg._fyn.preinstall");
        if (checked) {
          logger.log(`optional check ${pkgId} preinstall script already passed`);
          return { passed: true };
        } else if (_.get(res, "pkg.scripts.preinstall")) {
          logger.log("Running preinstall for optional dep", pkgId);
          const ls = new LifecycleScripts({
            appDir: this._fyn.cwd,
            dir: installedPath,
            json: res.pkg
          });
          return ls
            .execute(["preinstall"])
            .then(() => {
              logger.log(`optional check ${pkgId} preinstall script passed with exit code 0`);
              return { passed: true };
            })
            .catch(err => {
              logger.log(`optional check ${pkgId} preinstall script failed`, err.message);
              return { passed: false, err };
            });
        } else {
          // no preinstall script, always pass
          logger.log(`optional check ${pkgId} no preinstall script - automatic pass`);
          return { passed: true };
        }
      })
      .tap(res => {
        assert(
          this._checkedPkgs[pkgId] === undefined,
          `opt-resolver already checked package ${pkgId}`
        );
        this._checkedPkgs[pkgId] = res;
      })
      .finally(() => {
        this._inflights.remove(pkgId);
      });

    this._inflights.add(pkgId, promise);

    return processCheckResult(promise);
  }

  resolve() {
    this.start();
    return this._promiseQ.wait().then(() => {
      this._passedPkgs.forEach(x => {
        x.item.optChecked = true;
        this._depResolver.addPackageResolution(x.item, x.meta, x.item.resolved);
      });
      this._optPkgCount = 0;
      this._passedPkgs = [];
      this._depResolver.start();
    });
  }

  isEmpty() {
    return this._optPkgCount === 0;
  }
}

module.exports = PkgOptResolver;
