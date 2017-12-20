"use strict";

const Path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const Fs = require("fs");
const _ = require("lodash");
const chalk = require("chalk");
const simpleSemverCompare = require("./util/simple-semver-compare");
const Yaml = require("js-yaml");
const sortObjKeys = require("./util/sort-obj-keys");
const { LOCK_RSEMVERS, RSEMVERS, SORTED_VERSIONS, LOCK_SORTED_VERSIONS } = require("./symbols");
const logger = require("./logger");

class PkgDepLocker {
  constructor(lockOnly, lockfile) {
    this._lockfile = lockfile;
    this._lockOnly = lockOnly;
    this._lockData = {};
    this._isFynFormat = true;
  }

  get data() {
    return this._lockData;
  }

  //
  // generate lock data from dep data
  //
  generate(depData) {
    if (!this._lockfile) return;
    //
    // expect package names already sorted in depData
    //
    this._isFynFormat = true;
    const lockData = (this._lockData = {});
    const genFrom = pkgsData => {
      _.each(pkgsData, (pkg, name) => {
        const versions = Object.keys(pkg).sort(simpleSemverCompare);
        let _semvers = _.transform(
          pkg[RSEMVERS],
          (a, v, k) => {
            if (a[v]) a[v].push(k);
            else a[v] = [k];
            return a;
          },
          {}
        );
        _semvers = _.transform(
          _semvers,
          (a, v, k) => {
            a[v.sort().join(",")] = k;
            return a;
          },
          {}
        );
        const pkgLock = (lockData[name] = { _: sortObjKeys(_semvers) });
        /* eslint-disable complexity, max-statements */
        _.each(versions, version => {
          const vpkg = pkg[version];
          const json = vpkg.json || {};
          const meta = {};
          const dist = vpkg.dist || {};
          if (vpkg.top) meta.top = 1;
          if (vpkg.optFailed) meta.optFailed = 1;
          if (vpkg.local) {
            meta.$ = "local";
            meta._ = dist.fullPath;
          } else {
            meta.$ = dist.shasum || 0;
            meta._ = dist.tarball;
          }
          if (!_.isEmpty(json.dependencies)) meta.dependencies = json.dependencies;
          if (!_.isEmpty(json.optionalDependencies)) {
            meta.optionalDependencies = json.optionalDependencies;
          }
          if (!_.isEmpty(json.peerDependencies)) meta.peerDependencies = json.peerDependencies;
          if (vpkg.deprecated) meta.deprecated = vpkg.deprecated;
          const bd = json.bundleDependencies || json.bundledDependencies;
          if (!_.isEmpty(bd)) meta.bundleDependencies = bd;
          if (_.get(json, "scripts.preinstall")) meta.hasPI = 1;

          pkgLock[version] = meta;
        });
      });
    };

    genFrom(depData.getPkgsData());
    genFrom(depData.getPkgsData(true));
  }

  //
  // Take dep-item <item> with its real <meta> and update lock data
  //
  update(item, meta) {
    if (!this._lockfile) return;
    let locked = this._lockData[item.name];
    if (!locked) return meta;

    //
    // Add versions from <meta>
    //

    this._isFynFormat = false;

    if (!locked.hasOwnProperty(LOCK_SORTED_VERSIONS)) {
      locked = this.convert(item) || this._lockData[item.name];
    }

    _.defaults(locked.versions, meta.versions);
    const versions = Object.keys(locked.versions);
    locked[SORTED_VERSIONS] = versions.sort(simpleSemverCompare);
    locked["dist-tags"] = meta["dist-tags"];

    return locked;
  }

  //
  // convert from fyn lock format to npm meta format
  //
  convert(item) {
    if (!this._lockfile) return;
    let locked = this._lockData[item.name];
    if (!locked) return false;
    let valid = true;

    if (!locked.hasOwnProperty(LOCK_SORTED_VERSIONS)) {
      this._isFynFormat = false;
      const sorted = Object.keys(locked)
        .filter(x => !x.startsWith("_"))
        .sort(simpleSemverCompare);
      const versions = {};
      _.each(sorted, version => {
        const vpkg = locked[version];
        if (!_.isEmpty(vpkg) && vpkg._valid !== false) {
          if (vpkg.$ === "local") {
            vpkg.local = true;
            vpkg.dist = {
              shasum: "local",
              fullPath: vpkg._
            };
          } else {
            vpkg.dist = {
              shasum: vpkg.$,
              tarball: vpkg._
            };
          }
          vpkg.$ = vpkg._ = null;
          vpkg.name = item.name;
          vpkg.version = version;
          versions[version] = vpkg;
        } else {
          valid = false;
        }
      });
      const _semvers = _.transform(
        locked._,
        (a, v, k) => {
          k.split(",").forEach(sv => (a[sv] = v));
          return a;
        },
        {}
      );
      locked = this._lockData[item.name] = {
        [LOCK_RSEMVERS]: _semvers,
        [SORTED_VERSIONS]: sorted,
        [LOCK_SORTED_VERSIONS]: sorted,
        versions
      };
    }

    return valid && locked;
  }

  shasum(data) {
    return crypto
      .createHash("sha1")
      .update(data)
      .digest("hex");
  }
  //
  // save
  //
  save(filename) {
    if (!this._lockfile) return;
    if (!this._lockOnly) {
      assert(this._isFynFormat, "can't save lock data that's no longer in fyn format");
      const data = Yaml.dump(this._lockData, {
        indent: 1,
        lineWidth: 250,
        noCompatMode: true,
        condenseFlow: true
      });
      const shaSum = this.shasum(data);
      if (shaSum !== this._shaSum) {
        logger.info("saving lock file", filename);
        Fs.writeFileSync(filename, data);
      } else {
        logger.verbose("lock data didn't change");
      }
    }
  }

  read(filename) {
    if (!this._lockfile) return;
    try {
      const data = Fs.readFileSync(filename).toString();
      this._shaSum = this.shasum(data);
      this._lockData = Yaml.safeLoad(data);
      logger.info(chalk.green(`loaded lockfile ${Path.basename(filename)}`));
    } catch (err) {
      if (this._lockOnly) {
        logger.error(`failed to load lockfile ${filename} -`, err.message);
        logger.error("Can't proceed without lockfile in lock-only mode");
        process.exit(1);
      } else {
        logger.debug(`failed to load lockfile ${filename} -`, err.message);
      }
      this._shaSum = Date.now();
      this._lockData = {};
    }
  }
}

module.exports = PkgDepLocker;
