import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IgText, jumboEmoji, parseIgText, safeHref } from './igText';

const html = (text: string) => renderToStaticMarkup(<IgText text={text} />);

describe('parseIgText', () => {
  it('links http(s) URLs and leaves trailing punctuation out', () => {
    expect(parseIgText('see https://example.com/a_b?x=1. ok')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a_b?x=1', v: 'https://example.com/a_b?x=1' },
      { t: 'text', v: '. ok' },
    ]);
    expect(parseIgText('www.example.org')[0]).toMatchObject({ t: 'link', href: 'https://www.example.org/' });
  });

  it('marks @usernames but not e-mail addresses', () => {
    expect(parseIgText('hi @ali.veli and @ayse_k!')).toEqual([
      { t: 'text', v: 'hi ' },
      { t: 'mention', v: '@ali.veli' },
      { t: 'text', v: ' and ' },
      { t: 'mention', v: '@ayse_k' },
      { t: 'text', v: '!' },
    ]);
    expect(parseIgText('mail me: a@b.com')).toEqual([{ t: 'text', v: 'mail me: a@b.com' }]);
  });

  it('never creates markup or unsafe links from message text', () => {
    const out = html('<img src=x onerror=alert(1)> javascript:alert(1) <script>x</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('&lt;img');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(html('go https://x.test')).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps line breaks as text (CSS shows them)', () => {
    expect(parseIgText('a\nb')).toEqual([{ t: 'text', v: 'a\nb' }]);
  });

  it('detects emoji-only messages', () => {
    expect(jumboEmoji('😂')).toBe(true);
    expect(jumboEmoji('👍🏽❤️')).toBe(true);
    expect(jumboEmoji('ok 😂')).toBe(false);
    expect(jumboEmoji('😂😂😂😂')).toBe(false);
  });

  it('stays fast on long hostile input', () => {
    const t0 = performance.now();
    parseIgText('@a'.repeat(50_000) + 'https://'.repeat(10_000));
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
