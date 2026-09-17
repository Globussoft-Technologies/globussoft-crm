import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RichText, sanitizeRichTextHtml, truncateRichTextHtml } from '../utils/richText';

describe('Generic CRM rich-text display', () => {
  it('renders supported formatting while removing unsafe markup', () => {
    render(<RichText value={'<p>Hello <strong>World</strong></p><ul><li>Item</li></ul><script>alert(1)</script>'} />);

    expect(screen.getByText('World').tagName).toBe('STRONG');
    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).not.toContain('alert(1)');
  });

  it('decodes escaped HTML and preserves plain-text line breaks', () => {
    const escaped = sanitizeRichTextHtml('&lt;strong&gt;Hello&lt;/strong&gt;');
    const plain = sanitizeRichTextHtml('First line\nSecond line');

    expect(escaped).toContain('<strong>Hello</strong>');
    expect(plain).toContain('First line<br>Second line');
  });

  it('keeps safe links clickable and removes unsafe protocols', () => {
    const { container } = render(<RichText value={'<a href="https://example.com">Open link</a><a href="javascript:alert(1)">Unsafe</a>'} />);

    expect(screen.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', 'https://example.com/');
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.querySelectorAll('a')[1]).not.toHaveAttribute('href');
  });

  it('truncates only after the 50th word and keeps supported markup', () => {
    const value = `<p><strong>one two</strong> ${Array.from({ length: 48 }, (_, index) => `word${index + 3}`).join(' ')} word51</p>`;
    const result = truncateRichTextHtml(value, 50);

    expect(result.wordCount).toBe(51);
    expect(result.truncated).toBe(true);
    expect(result.html).toContain('<strong>one two</strong>');
    expect(result.html).toContain('word50');
    expect(result.html).not.toContain('word51');
  });

  it('does not add a truncation for 50 words or fewer', () => {
    const result = truncateRichTextHtml(Array.from({ length: 50 }, (_, index) => `word${index + 1}`).join(' '), 50);

    expect(result.wordCount).toBe(50);
    expect(result.truncated).toBe(false);
  });
});
