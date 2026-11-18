export function resolveNotificationLink(notification, vertical) {
  const link = notification?.link;
  if (typeof link !== 'string' || !link) return link;

  if (
    vertical === 'travel'
    && String(notification?.entityType || '').toLowerCase() === 'lead'
    && /^\/contacts\/\d+(?:[/?#]|$)/.test(link)
  ) {
    return link.replace(/^\/contacts\//, '/travel/leads/');
  }

  return link;
}
