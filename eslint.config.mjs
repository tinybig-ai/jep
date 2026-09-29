// One job: no promise may fail with nobody listening. Node treats a rejection
// nobody handles as fatal, so a single fire-and-forget call that failed (an
// abort sent to an opencode server that had hung) took the whole daemon down,
// Telegram and every other harness with it. Type-aware, so it also finds the
// ones grep cannot: a promise dropped in a callback, or an async function
// handed to something that ignores what it returns.
import tseslint from "typescript-eslint"

export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    // `void p` does not count as handling it: it is exactly what failed
    "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
    "@typescript-eslint/no-misused-promises": "error",
  },
})
