// typescript-eslint does not support TS 7 yet (typescript-eslint#10940). Give its packages the
// TS 6 API side by side; the rest of the repo keeps building with TS 7.
const TS6 = 'npm:@typescript/typescript6@^6.0.2';

function readPackage(pkg) {
  if (pkg.name === 'typescript-eslint' || pkg.name?.startsWith('@typescript-eslint/')) {
    if (pkg.peerDependencies?.typescript) {
      delete pkg.peerDependencies.typescript;
      pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
