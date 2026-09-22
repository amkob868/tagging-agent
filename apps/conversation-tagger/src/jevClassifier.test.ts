import { describe, it, expect, vi } from 'vitest';

vi.mock('@support-agent-aws/shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  tagsFromJevAnswers,
  buildJevQuestions,
  questionKeyForTag,
  SUPPORT_TAG_QUESTIONS,
  PRINTS_TAG_QUESTIONS,
} from './jevClassifier';

describe('questionKeyForTag', () => {
  it('turns tag names into safe identifiers', () => {
    expect(questionKeyForTag('how do i respond to my customer')).toBe('how_do_i_respond_to_my_customer');
    expect(questionKeyForTag('2.0 how do I')).toBe('2_0_how_do_i');
    expect(questionKeyForTag('foam board poster')).toBe('foam_board_poster');
  });

  it('produces unique keys for every configured tag', () => {
    for (const map of [SUPPORT_TAG_QUESTIONS, PRINTS_TAG_QUESTIONS]) {
      const keys = Object.keys(map).map(questionKeyForTag);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('buildJevQuestions', () => {
  it('emits one noul question per tag and passes criteria through', () => {
    const questions = buildJevQuestions({
      'downloads': { instructions: 'About downloads?' },
      'rush order': { instructions: 'Rush?', criteria: { true: 'yes', false: 'no' } },
    });
    expect(questions).toEqual({
      downloads: { type: 'noul', instructions: 'About downloads?' },
      rush_order: { type: 'noul', instructions: 'Rush?', criteria: { true: 'yes', false: 'no' } },
    });
  });
});

describe('tagsFromJevAnswers', () => {
  const tagQuestions = {
    'downloads': { instructions: 'x' },
    'cancel': { instructions: 'x' },
    'rush order': { instructions: 'x' },
  };

  it('applies tags at or above the 70% threshold only', () => {
    const { tags, scores } = tagsFromJevAnswers(
      {
        downloads: { type: 'noul', noul: 0.99 },
        cancel: { type: 'noul', noul: 0.69 },
        rush_order: { type: 'noul', noul: 0.7 },
      },
      tagQuestions,
      0.7
    );
    expect(tags).toEqual(['downloads', 'rush order']);
    expect(scores).toEqual({ downloads: 0.99, cancel: 0.69, 'rush order': 0.7 });
  });

  it('skips missing or malformed answers', () => {
    const { tags, scores } = tagsFromJevAnswers(
      {
        downloads: { type: 'noul', noul: 0.9 },
        cancel: { type: 'choice', choice: 'yes' },
      },
      tagQuestions,
      0.7
    );
    expect(tags).toEqual(['downloads']);
    expect(scores).toEqual({ downloads: 0.9 });
  });

  it('returns nothing when answers are absent', () => {
    expect(tagsFromJevAnswers(undefined, tagQuestions, 0.7)).toEqual({ tags: [], scores: {} });
  });
});
