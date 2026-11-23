import { useContext } from 'react';
import { AuthContext } from '../appContexts';
import ContactDetail from './ContactDetail';
import WellnessLeadDetail from './wellness/WellnessLeadDetail';

export default function ContactDetailRoute(props) {
  const { tenant } = useContext(AuthContext);
  return tenant?.vertical === 'wellness'
    ? <WellnessLeadDetail />
    : <ContactDetail {...props} />;
}
