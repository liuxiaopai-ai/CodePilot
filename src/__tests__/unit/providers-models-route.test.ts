import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelEndpointCandidates,
  deduplicateModels,
  extractModelOptionsFromPayload,
  getFallbackModelsForBaseUrl,
  normalizeBaseUrl,
} from '../../app/api/providers/models/route';

describe('providers models route helpers', () => {
  it('normalizes base_url for robust mapping', () => {
    assert.equal(normalizeBaseUrl('HTTPS://API.KIMI.COM/coding///'), 'https://api.kimi.com/coding');
    assert.equal(normalizeBaseUrl(' https://open.bigmodel.cn/api/anthropic/ '), 'https://open.bigmodel.cn/api/anthropic');
  });

  it('uses provider-native fallback model IDs for third-party providers', () => {
    const glmModels = getFallbackModelsForBaseUrl('https://open.bigmodel.cn/api/anthropic/');
    assert.deepEqual(glmModels.map((m) => m.value), ['glm-4.7', 'glm-5', 'glm-4.5-air']);

    const kimiModels = getFallbackModelsForBaseUrl('https://api.kimi.com/coding/');
    assert.deepEqual(kimiModels.map((m) => m.value), ['kimi-k2.5']);

    const minimaxModels = getFallbackModelsForBaseUrl('https://api.minimax.io/anthropic/');
    assert.deepEqual(minimaxModels.map((m) => m.value), ['MiniMax-M2.5']);

    for (const value of [...glmModels, ...kimiModels, ...minimaxModels].map((m) => m.value)) {
      assert.notEqual(value, 'sonnet');
      assert.notEqual(value, 'opus');
      assert.notEqual(value, 'haiku');
    }
  });

  it('keeps native Anthropic defaults unchanged for backward compatibility', () => {
    const anthropicModels = getFallbackModelsForBaseUrl('https://api.anthropic.com');
    assert.deepEqual(anthropicModels.map((m) => m.value), ['sonnet', 'opus', 'haiku']);
  });

  it('extracts model options from common /v1/models response shapes', () => {
    const fromData = extractModelOptionsFromPayload({
      data: [
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.7', display_name: 'GLM-4.7' },
      ],
    });
    assert.deepEqual(fromData, [
      { value: 'glm-5', label: 'GLM-5' },
      { value: 'glm-4.7', label: 'GLM-4.7' },
    ]);

    const fromModels = extractModelOptionsFromPayload({
      models: ['model-a', 'model-b'],
    });
    assert.deepEqual(fromModels, [
      { value: 'model-a', label: 'model-a' },
      { value: 'model-b', label: 'model-b' },
    ]);
  });

  it('builds model endpoint candidates for anthropic-compatible providers', () => {
    const moonshotCandidates = buildModelEndpointCandidates('https://api.moonshot.cn/anthropic/');
    assert.deepEqual(moonshotCandidates, [
      'https://api.moonshot.cn/anthropic/v1/models',
      'https://api.moonshot.cn/v1/models',
    ]);

    const kimiCandidates = buildModelEndpointCandidates('https://api.kimi.com/coding/');
    assert.deepEqual(kimiCandidates, ['https://api.kimi.com/coding/v1/models']);
  });

  it('deduplicates by label while keeping first match', () => {
    const deduped = deduplicateModels([
      { value: 'id-1', label: 'Same' },
      { value: 'id-2', label: 'Same' },
      { value: 'id-3', label: 'Different' },
    ]);
    assert.deepEqual(deduped, [
      { value: 'id-1', label: 'Same' },
      { value: 'id-3', label: 'Different' },
    ]);
  });
});
