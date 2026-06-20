/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 120,
  tabWidth: 2,
  arrowParens: "always",
  endOfLine: "lf",
  plugins: ["prettier-plugin-organize-imports"],
};
