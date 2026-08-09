import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUPS = Object.freeze({
  'source-only'() {
    return [];
  },
  'fixture-text'(worktreePath) {
    writeFileSync(join(worktreePath, 'fixture.txt'), 'broken\n', { encoding: 'utf8', mode: 0o644 });
    return ['fixture.txt'];
  },
});

export function applySetupProfile(profileId, worktreePath) {
  const setup = SETUPS[profileId];
  if (!setup) throw new Error(`Unknown registered setup profile: ${profileId}`);
  return setup(worktreePath);
}
