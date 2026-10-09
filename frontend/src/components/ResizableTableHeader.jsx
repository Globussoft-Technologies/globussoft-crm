export default function ResizableTableHeader({
  children,
  label,
  width,
  minWidth = 80,
  onResize,
  style,
}) {
  const startResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;

    const handleMove = (moveEvent) => {
      onResize(Math.max(minWidth, startWidth + moveEvent.clientX - startX));
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const resizeWithKeyboard = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onResize(Math.max(minWidth, width + (event.key === 'ArrowRight' ? 10 : -10)));
  };

  return (
    <th aria-label={label} style={{ ...style, width, minWidth }}>
      {children}
      <span
        role="separator"
        aria-label={`Resize ${label} column`}
        aria-orientation="vertical"
        title={`Drag to resize ${label}`}
        tabIndex="0"
        onMouseDown={startResize}
        onKeyDown={resizeWithKeyboard}
        style={{
          position: 'absolute', top: 0, right: 0, width: 8, height: '100%',
          cursor: 'col-resize', userSelect: 'none', touchAction: 'none', zIndex: 3,
          borderRight: '2px solid transparent',
        }}
      />
    </th>
  );
}
