import { handleCliError } from "./cli-error.js";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  process.exitCode = handleCliError(error);
}
