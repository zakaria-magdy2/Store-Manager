const { cpSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

/**
 * electron-builder intentionally strips node_modules directories from extraResources.
 * Copy the pre-flattened, symlink-free runtime node_modules directly into resources/web/node_modules
 * before NSIS/zip packaging runs.
 */
exports.default = function afterPack(context) {
  const desktopDir = context.packager.projectDir;
  const srcNodeModules = join(desktopDir, 'stage', 'web', 'node_modules');
  const destNodeModules = join(context.appOutDir, 'resources', 'web', 'node_modules');

  if (!existsSync(srcNodeModules)) {
    throw new Error(`Missing staged web node_modules at ${srcNodeModules}`);
  }

  rmSync(destNodeModules, { recursive: true, force: true });
  cpSync(srcNodeModules, destNodeModules, { recursive: true, dereference: true });
};
