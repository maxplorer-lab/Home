// Publishes a change signal to every connected client. Metadata only: clients
// compare the version and refetch from D1 when it is stale.

export async function notify(env, payload) {
  try {
    const id = env.LOBBY.idFromName('household');
    const stub = env.LOBBY.get(id);
    await stub.fetch('https://lobby/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    // A failed broadcast must never fail the write that triggered it: clients
    // also refetch on focus and reconnect.
  }
}

// Broadcast without making the caller wait. The response returns immediately
// and waitUntil keeps the Worker alive until the broadcast is done. Awaiting
// the Durable Object instead added seconds to every write, because a
// hibernating object has to be woken first.
export function notifyAsync(context, payload) {
  const promise = notify(context.env, payload);
  if (context && context.exec && typeof context.exec.waitUntil === 'function') {
    context.exec.waitUntil(promise);
  } else {
    promise.catch(function () {});
  }
}

export function lobbyStub(env) {
  return env.LOBBY.get(env.LOBBY.idFromName('household'));
}
