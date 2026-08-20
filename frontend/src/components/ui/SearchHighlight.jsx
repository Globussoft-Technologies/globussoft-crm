import React from 'react';

export const SEARCH_HIGHLIGHT_MARK_STYLE = {
  backgroundColor: 'rgba(245, 158, 11, 0.45)',
  color: '#111827',
  borderRadius: '0.2em',
  padding: '0 0.08em',
  boxDecorationBreak: 'clone',
  WebkitBoxDecorationBreak: 'clone',
  fontWeight: 700,
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightTextSegments(text, query) {
  const source = text == null ? '' : String(text);
  const needle = String(query ?? '').trim();
  if (!source || !needle) {
    return [{ text: source, highlighted: false }];
  }

  const matcher = new RegExp(escapeRegExp(needle), 'ig');
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = matcher.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        text: source.slice(lastIndex, match.index),
        highlighted: false,
      });
    }

    parts.push({
      text: match[0],
      highlighted: true,
    });

    lastIndex = match.index + match[0].length;

    // Guard against zero-length regex matches if the implementation changes.
    if (match[0].length === 0) matcher.lastIndex += 1;
  }

  if (lastIndex < source.length) {
    parts.push({
      text: source.slice(lastIndex),
      highlighted: false,
    });
  }

  return parts.length > 0 ? parts : [{ text: source, highlighted: false }];
}

export default function SearchHighlight({
  text,
  query,
  as: Wrapper = 'span',
  className,
  style,
  highlightStyle,
  ...props
}) {
  const segments = highlightTextSegments(text, query);

  return (
    <Wrapper className={className} style={style} {...props}>
      {segments.map((segment, idx) =>
        segment.highlighted ? (
          <mark
            key={`highlight-${idx}`}
            style={{ ...SEARCH_HIGHLIGHT_MARK_STYLE, ...highlightStyle }}
          >
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={`text-${idx}`}>{segment.text}</React.Fragment>
        ),
      )}
    </Wrapper>
  );
}
