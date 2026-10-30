import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts'],
    environment: 'node',
    // No test may reach a real model, whatever keys the shell holds.
    env: Object.fromEntries(
      [
        'OPENROUTER_API_KEY',
        'AI_GATEWAY_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'BUGPATROL_MODEL_ENDPOINT',
        'BUGPATROL_MODEL_API_KEY',
        'BUGPATROL_MODEL_NAME',
        'BUGHUNTERS_MODEL_ENDPOINT',
        'BUGHUNTERS_MODEL_API_KEY',
        'BUGHUNTERS_MODEL_NAME',
      ].map((key) => [key, '']),
    ),
  },
});
