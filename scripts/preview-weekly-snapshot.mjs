// Keep the original preview command read-only.
import { main } from "./save-weekly-snapshot.mjs";

if (process.argv.length > 2) {
  console.error("Preview only: this script accepts no arguments.");
  process.exitCode = 1;
} else {
  main([]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
