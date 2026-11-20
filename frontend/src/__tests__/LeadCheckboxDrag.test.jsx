import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useLeadCheckboxDrag } from '../utils/useLeadCheckboxDrag';

function Rows() {
  const [ids,setIds] = useState([4]);
  const drag = useLeadCheckboxDrag(setIds);
  return <table><tbody>{[1,2,3,4].map(id => <tr key={id}><td>
    <input type="checkbox" aria-label={'Lead '+id} checked={ids.includes(id)} {...drag(id)}
      onChange={()=>setIds(prev=>prev.includes(id)?prev.filter(item=>item!==id):[...prev,id])}/>
  </td></tr>)}</tbody></table>;
}

it('paints crossed rows once, preserves other selections, and erases from a checked row', () => {
  render(<Rows/>);
  const boxes = screen.getAllByRole('checkbox');
  boxes.forEach((box,i) => { box.getBoundingClientRect=()=>({left:10,right:30,top:40*i,bottom:40*i+20,width:20,height:20}); });
  const point = y => ({button:0,isPrimary:true,pointerId:1,clientX:20,clientY:y});
  fireEvent.pointerDown(boxes[0],point(10));
  fireEvent.pointerMove(window,point(90));
  fireEvent.pointerMove(window,point(50));
  fireEvent.pointerUp(window,point(50));
  expect(boxes.map(box=>box.checked)).toEqual([true,true,true,true]);
  fireEvent.pointerDown(boxes[2],point(90));
  fireEvent.pointerMove(window,point(50));
  fireEvent.pointerUp(window,point(50));
  expect(boxes.map(box=>box.checked)).toEqual([true,false,false,true]);
  fireEvent.click(boxes[0],{detail:0});
  expect(boxes[0]).not.toBeChecked();
});

it('clears selection with Escape and cancels any pending drag update', () => {
  render(<Rows/>);
  const boxes = screen.getAllByRole('checkbox');
  fireEvent.keyDown(window, {key:'Escape'});
  expect(boxes.every(box => !box.checked)).toBe(true);
  boxes.forEach((box,i) => {
    box.getBoundingClientRect = vi.fn(() => ({left:10,right:30,top:40*i,bottom:40*i+20,width:20,height:20}));
  });
  const point = y => ({button:0,isPrimary:true,pointerId:1,clientX:20,clientY:y});
  fireEvent.pointerDown(boxes[0],point(10));
  fireEvent.pointerMove(window,point(50));
  fireEvent.pointerMove(window,point(90));
  fireEvent.keyDown(window, {key:'Escape'});
  fireEvent.pointerUp(window,point(90));
  expect(boxes.every(box => !box.checked)).toBe(true);
  for (const box of boxes) expect(box.getBoundingClientRect).toHaveBeenCalledTimes(1);
});

it('scrolls at the edge while held, selects newly exposed boxes and stops on release', () => {
  vi.useFakeTimers();
  try {
    const {container} = render(<div style={{overflowY:'auto'}}><Rows/></div>);
    const pane = container.firstChild;
    Object.defineProperties(pane,{scrollHeight:{value:160},clientHeight:{value:80}});
    pane.getBoundingClientRect = () => ({top:0,bottom:80});
    const boxes = screen.getAllByRole('checkbox');
    boxes.forEach((box,i) => {
      box.getBoundingClientRect = () => ({left:10,right:30,top:i*40-pane.scrollTop,bottom:i*40+20-pane.scrollTop,width:20,height:20});
    });
    const point = y => ({button:0,isPrimary:true,pointerId:1,clientX:20,clientY:y});
    fireEvent.pointerDown(boxes[0],point(10));
    fireEvent.pointerMove(window,point(82));
    act(()=>vi.advanceTimersByTime(64));
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(boxes[2]).toBeChecked();
    fireEvent.pointerUp(window,point(82));
    const released = pane.scrollTop;
    act(()=>vi.advanceTimersByTime(100));
    expect(pane.scrollTop).toBe(released);
  } finally { vi.useRealTimers(); }
});
