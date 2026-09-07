#!/usr/bin/env node
/*
 * Type-checks everything that does not depend on React or Syncfusion typings.
 *
 * `npm run typecheck` needs the installed packages; this one runs anywhere, so the
 * core, the adapters and the pure wrapper modules are always verified — the layer where
 * a type error means a real defect rather than a missing @types package.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const FILES = [
  "src/core/*.ts",
  "src/adapters/jornada/*.ts",
  "src/adapters/in-memory.ts",
  "src/syncfusion/mapper.ts",
  "src/syncfusion/edit-bridge.ts",
  "src/syncfusion/editing-policy.ts",
  "src/syncfusion/display-toggles.ts",
]

const tsc = ["node_modules/typescript/bin/tsc", "node_modules/.bin/tsc"].find(existsSync)
if (!tsc) {
  console.log("TypeScript não instalado; execute `npm install` e depois `npm run typecheck`.")
  process.exit(0)
}

const result = spawnSync(process.execPath, [
  tsc, "--noEmit", "--strict", "--target", "ES2022", "--lib", "ES2022,DOM",
  "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck",
  "--noUnusedLocals", "--noUnusedParameters", ...FILES,
], { stdio: "inherit", shell: process.platform === "win32" })

process.exit(result.status ?? 1)
