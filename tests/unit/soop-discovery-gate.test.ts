import { soopStreamInCategory } from '../../src/utils/soop-discovery-gate';

describe('soopStreamInCategory', () => {
  it('keeps only streams in the configured category', () => {
    expect(soopStreamInCategory({ platformCategoryId: '00040066' }, '00040066')).toBe(true);
    expect(soopStreamInCategory({ platformCategoryId: '40066' }, '00040066')).toBe(true);
    expect(soopStreamInCategory({ platformCategoryId: '00040001' }, '00040066')).toBe(false);
  });
  it('drops every SOOP hit when the series has no SOOP category', () => {
    expect(soopStreamInCategory({ platformCategoryId: '00040066' }, undefined)).toBe(false);
    expect(soopStreamInCategory({ platformCategoryId: '00040066' }, null)).toBe(false);
  });
  it('drops a hit whose category is unknown', () => {
    expect(soopStreamInCategory({}, '00040066')).toBe(false);
  });
});
