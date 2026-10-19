import { createElement, forwardRef, useContext } from 'react';
import { IconThemeContext } from './IconThemeContext';

function renderNode(node, key) {
  return createElement(node.tag, { ...node.attrs, key },
    node.children?.map((child, index) => renderNode(child, index)));
}

/** Preserve the existing SVG API, sizing, refs, accessible labels and events.
 * Ant Design's official SVG definitions avoid introducing span wrappers or
 * replacing any of the app's existing controls with a different UI framework.
 */
export function createThemedIcon(LucideIcon, antDefinition, name) {
  const ThemedIcon = forwardRef(function ThemedIcon(props, ref) {
    const useAntIcons = useContext(IconThemeContext);
    if (!useAntIcons) return <LucideIcon {...props} ref={ref} />;
    const { size = 24, color = 'currentColor', strokeWidth: _strokeWidth,
      absoluteStrokeWidth: _absoluteStrokeWidth, className = '', children, ...rest } = props;
    const kebabName = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size}
        viewBox={antDefinition.icon.attrs.viewBox || '0 0 1024 1024'}
        fill={color} stroke="none" focusable="false"
        aria-hidden={props['aria-label'] || props['aria-labelledby'] || props.role === 'img' ? undefined : true}
        className={`lucide lucide-${kebabName} ant-design-icon ${className}`.trim()}
        {...rest} ref={ref} data-icon-library="ant-design" data-icon-name={antDefinition.name}>
        {antDefinition.icon.children?.map((node, index) => renderNode(node, index))}
        {children}
      </svg>
    );
  });
  ThemedIcon.displayName = `Themed${name}`;
  return ThemedIcon;
}
