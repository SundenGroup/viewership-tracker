import { languageDisplayName } from '../../src/utils/language-names';

describe('languageDisplayName', () => {
  it('names the codes the reports showed as bare codes', () => {
    expect(languageDisplayName('sr')).toBe('Serbian');
    expect(languageDisplayName('bg')).toBe('Bulgarian');
    expect(languageDisplayName('BG')).toBe('Bulgarian');
  });
  it('folds region subtags to the base language', () => {
    expect(languageDisplayName('pt-BR')).toBe('Portuguese');
    expect(languageDisplayName('en_US')).toBe('English');
  });
  it('keeps house codes and falls back to the uppercased code', () => {
    expect(languageDisplayName('tw')).toBe('Taiwanese');
    expect(languageDisplayName('other')).toBe('Other');
    expect(languageDisplayName('xx')).toBe('XX');
    expect(languageDisplayName(null)).toBe('Unknown');
  });
});
