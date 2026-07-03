import React from 'react';
import { escapeHtml } from '../../utils/landingPageUtils';

export default function HeadingBlock({ props = {} }) {
  const level = props.level || 'h1';
  const align = props.align || 'left';
  const color = props.color || '#1a1a1a';
  const text = props.text || '';

  const HeadingTag = level;

  return (
    <HeadingTag
      style={{
        color,
        textAlign: align,
        margin: '0 0 16px 0',
      }}
    >
      {text}
    </HeadingTag>
  );
}
