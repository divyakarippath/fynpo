"use strict";

/* eslint-disable */

const Fs = require("fs");
const Yaml = require("js-yaml");
const Path = require("path");
const Fyn = require("../../lib/fyn");
const mockNpm = require("../fixtures/mock-npm");
const expect = require("chai").expect;
const _ = require("lodash");
const PkgDepLinker = require("../../lib/pkg-dep-linker");
const xsh = require("xsh");

describe("pkg-dist-fetcher", function() {
  const fynDir = Path.join(__dirname, `../.tmp_${Date.now()}`);

  let server;
  before(() => {
    return mockNpm().then(s => (server = s));
  });

  after(done => {
    xsh.$.rm("-rf", fynDir);
    server.stop(done);
  });

  it("should fetch package tarballs for pkg-a fixture", () => {
    const registry = `http://localhost:${server.info.port}`;
    const targetDir = `xout_${Date.now()}`;
    const fyn = new Fyn({
      registry,
      pkgFile: Path.join(__dirname, "../fixtures/pkg-a/package.json"),
      cwd: fynDir,
      targetDir,
      fynDir,
      ignoreDist: true
    });
    // TODO: verify tarballs actually fetched
    return fyn.resolveDependencies().then(() => fyn.fetchPackages());
  }).timeout(10000);
});
