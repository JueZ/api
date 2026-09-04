import assert from 'node:assert/strict';
import test from 'node:test';
import { SupadataYouTubeTranscriptProvider } from '../dist/shared/youtube/client.js';

const enabled = process.env.YOUTUBE_LIVE_PROVIDER_TEST === 'true';

test(
  'live external: production adapter accepts the known Supadata transcript fixture video',
  { skip: !enabled },
  async () => {
    const apiKey = process.env.SUPADATA_API_KEY?.trim();
    assert.ok(apiKey, 'SUPADATA_API_KEY is required only when YOUTUBE_LIVE_PROVIDER_TEST=true');

    const result = await new SupadataYouTubeTranscriptProvider(apiKey).fetchNativeTranscript({
      videoId: 'ZOE9ud6rSSw',
    });

    assert.equal(result.language, 'en');
    assert.ok(result.availableLanguages.includes('en'));
    assert.ok(result.content.length > 0);
    for (const segment of result.content) {
      assert.equal(typeof segment.text, 'string');
      assert.ok(segment.text.length > 0);
      assert.ok(Number.isSafeInteger(segment.offsetMs));
      assert.ok(Number.isSafeInteger(segment.durationMs));
    }
    // Transcript text is intentionally never written to CI or terminal logs.
  },
);
