import { useCallback, useState } from 'react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { loadRazorpaySdk } from '../../../utils/razorpay';

/**
 * Buying a package from the customer catalog.
 *
 * Two-step handshake, the same one the appointment "pay now" flow uses:
 *
 *   1. POST /packages/:id/buy      → Razorpay order + a PENDING Payment row.
 *   2. POST /packages/confirm-payment → signature verified server-side, and
 *      only then is the patient's plan created.
 *
 * The amount is never sent from here — the server prices the package from its
 * stored figures, so a tampered page cannot change what is charged. The
 * returned breakdown is display-only.
 *
 * `onPurchased` fires after fulfilment so the caller can refresh its list.
 */
export default function usePackageCheckout({ onPurchased, clinicName = 'Wellness' } = {}) {
  const notify = useNotify();
  const [buyingId, setBuyingId] = useState(null);

  const buy = useCallback(async (pkg) => {
    if (!pkg?.id) return;
    setBuyingId(pkg.id);

    let order;
    try {
      order = await fetchApi(`/api/wellness/packages/${pkg.id}/buy`, { method: 'POST' });
    } catch (err) {
      notify.error(err?.message || 'Could not start the payment');
      setBuyingId(null);
      return;
    }

    try {
      await loadRazorpaySdk();
    } catch (err) {
      notify.error(err?.message || 'Could not load Razorpay');
      setBuyingId(null);
      return;
    }

    const rzp = new window.Razorpay({
      key: order.key,
      amount: order.amount,
      currency: order.currency,
      name: clinicName,
      description: order.package?.name || pkg.name,
      order_id: order.orderId,
      theme: { color: '#a07c4a' },
      // Closing the sheet is not a failure — just release the button.
      modal: { ondismiss: () => setBuyingId(null) },
      handler: async (resp) => {
        try {
          const confirmed = await fetchApi('/api/wellness/packages/confirm-payment', {
            method: 'POST',
            body: JSON.stringify({
              paymentId: order.paymentId,
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            }),
          });
          if (confirmed.success) {
            notify.success(`"${order.package?.name || pkg.name}" is yours — it's now in your packages.`);
            onPurchased?.(confirmed);
          } else {
            notify.error('Payment went through but activation failed — the clinic will be in touch.');
          }
        } catch (err) {
          // The charge already succeeded here, so the payment id is the thing
          // the customer needs if they have to chase it.
          notify.error(
            err?.message
              || `Payment captured but activation failed. Keep this payment id: ${resp.razorpay_payment_id}`,
          );
        } finally {
          setBuyingId(null);
        }
      },
    });

    rzp.on('payment.failed', (resp) => {
      notify.error(resp?.error?.description || 'Payment failed. Try another card or method.');
      setBuyingId(null);
    });
    rzp.open();
  }, [notify, onPurchased, clinicName]);

  return { buy, buyingId };
}
