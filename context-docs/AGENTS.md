 claude, review context-docs/workflow/* (system_instructions.md) This is your build file. You don't really need to use any other guide.
  However if this doc is unclear or ambiguous, then respectively, as a cascade, check architecture.md, next if confused, check
  strategy.md, and finally if needed, check requirements.md. But to save tokens, avoid checking outside system_instructions.md unless
  necessary.

  The application is already built, you don't need to rebuild it from scratch. Its iterating, so we actually just need to add anything that's not already in system instructions to the application, update the application itself (including any components in the pipeline such as schema, input data, code, everything that gets updated) so before you start, just do a diff on the the existing codebase to the system instructions and present an update delta plan. 