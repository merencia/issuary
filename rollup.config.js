import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { builtinModules } from "node:module";
import pkg from "./package.json" with { type: "json" };

const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(pkg.dependencies || {}),
];

export default {
  input: "src/cli.ts",
  output: {
    file: "dist/cli.js",
    format: "esm",
    banner: "#!/usr/bin/env node",
    sourcemap: true,
  },
  external,
  plugins: [
    resolve({ preferBuiltins: true }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      sourceMap: true,
      exclude: ["**/*.test.ts"],
    }),
  ],
};
