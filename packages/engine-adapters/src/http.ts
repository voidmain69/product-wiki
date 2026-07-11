import { Agent, interceptors, request, type Dispatcher } from "undici";

/**
 * Спільний undici-диспетчер з redirect-інтерцептором. У undici 6+ опція
 * `maxRedirections` на дефолтному агенті не підтримується — редиректи вмикаються
 * лише через інтерцептор. Тримаємо один агент на процес (пул з'єднань).
 */
export const redirectDispatcher: Dispatcher = new Agent().compose(
  interceptors.redirect({ maxRedirections: 5 }),
);

/** GET із дотриманням редиректів і вказаним User-Agent. */
export function httpGet(url: string, userAgent: string, accept = "text/html,application/xhtml+xml") {
  return request(url, {
    method: "GET",
    headers: { "user-agent": userAgent, accept },
    dispatcher: redirectDispatcher,
  });
}
