import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DialQueuePanel from '../components/DialQueuePanel';

function setup(props = {}) {
  const stopDialing = vi.fn();
  const cancel = vi.fn();
  render(<DialQueuePanel jobs={[{ id: 12, total: 2, status: 'scheduled', scheduled: true, scheduledAt: '2099-01-01T09:00:00Z' }]}
    queues={{ timezone: 'Asia/Kolkata', workerEnabled: true, autoDial: {enabled:true, queued:2},
      pending: { enabled:true, due:1, upcoming:0, entries:[{id:1,name:'Example lead',callifiedDnpNextRetryAt:'2025-01-01T07:00:00Z'}] },
      serverTime:new Date().toISOString(), calls:[] }} campaigns={[]} live={{done:1,total:3}} isDialing canManage canWrite
    stopDialing={stopDialing} cancel={cancel} {...props} />);
  return {stopDialing, cancel};
}
it('filters the real queue and routes schedule cancellation to the selected job', () => {
  const {cancel} = setup();
  expect(screen.getByText('Example lead')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Scheduled 1'}));
  expect(screen.queryByText('Example lead')).toBeNull();
  expect(screen.getByText('Asia/Kolkata')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Cancel schedule · 2 leads'}));
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({id:12}));
});
it('requires confirmation even when the drawer opens from the toolbar stop icon', () => {
  const {stopDialing} = setup({initialConfirm:true});
  fireEvent.click(screen.getByRole('button',{name:'Keep dialing'}));
  expect(stopDialing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Stop all dialing'}));
  fireEvent.click(screen.getByRole('button',{name:'Stop everything'}));
  expect(stopDialing).toHaveBeenCalledOnce();
});
it('separates stopped schedules and allows stopping before the first call', () => {
  const {stopDialing} = setup({isDialing:false, jobs:[
    {id:1, status:'scheduled', scheduled:true, total:1, scheduledAt:'2099-01-01T09:00:00Z'},
    {id:2, status:'cancelled', scheduled:true, total:3, completed:1},
  ]});
  fireEvent.click(screen.getByRole('button',{name:'Scheduled 1'}));
  expect(screen.queryByText('3 leads')).toBeNull();
  expect(screen.queryByText('Dialing now')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Stop all dialing'}));
  fireEvent.click(screen.getByRole('button',{name:'Stop everything'}));
  expect(stopDialing).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Stopped 1'}));
  expect(screen.getByText('3 leads')).toBeInTheDocument();
  expect(screen.queryByText('Cancel schedule')).toBeNull();
});
