import { fireEvent, render, screen } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import DialRunHistory, { ScheduleAudience } from '../components/DialRunHistory';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api',()=>({fetchApi:vi.fn()}));

it('loads campaign members only when expanded and pages inside the card', async()=>{
  fetchApi.mockReset().mockResolvedValueOnce({leads:[{id:1,name:'Asha',phone:'5550101'}],hasMore:true})
    .mockResolvedValueOnce({leads:[{id:26,name:'Sam',phone:'5550126'}]});
  render(<ScheduleAudience job={{id:7,total:26,campaignIds:[8],status:'stopped'}} campaigns={[{id:8,name:'Outreach'}]}/>);
  const toggle = screen.getByRole('button',{name:'View leads (26)'});
  expect(fetchApi).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded','true');
  expect(await screen.findByText('Asha')).toBeInTheDocument();
  expect(screen.getByText(/Campaigns: Outreach/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Next'}));
  expect(await screen.findByText('5550126')).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.queryByText('Sam')).toBeNull();
});

it('counts individual and bulk calls together and filters recorded retry history',async()=>{
  fetchApi.mockReset().mockResolvedValueOnce({jobs:['single','run','pending','dnp','auto','scheduled'].map((runType,id)=>({
    id,runType,total:1,status:'completed',firstDialAt:'2026-11-19T01:00:00Z',outcomes:{pending:1},leads:[{id,name:'Lead '+id,phone:'5550100',outcome:'pending'}]
  }))});
  render(<DialRunHistory timezone="UTC" onCount={vi.fn()}/>);
  expect(await screen.findByRole('button',{name:'Normal calls 2'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/Show 1 more runs/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Pending retries 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Show details for 1 lead'}));
  expect(await screen.findByText('Lead 2')).toBeInTheDocument();
  expect(screen.getByText('1 Pending')).toBeInTheDocument();
});
