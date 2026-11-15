import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
/**
 * `KeenableSearchProvider`: a `WebSearchProvider` backed by the Keenable search
 * API (`POST /v1/search`, or the keyless `POST /v1/search/public` when no API
 * key resolves). It maps the first non-blank of `snippet` then `description` to
 * `snippet`, collapses the excerpt to one line and enforces the configured
 * budget, maps `published_at` to `publishedAt`, normalizes and dedupes result
 * URLs, drops entries without a portable snippet, and omits `content` because
 * Keenable returns no generated answer.
 * @module @lliangworld/dsh-web-search-keenable/provider
 */
/** Stable id this provider registers under. */
const KEENABLE_PROVIDER_ID = "keenable";
/** Default Keenable endpoint base; `/v1/search` is the keyed operation. */
const KEENABLE_DEFAULT_BASE_URL = "https://api.keenable.ai";
/** The keyed search operation appended to the base URL. */
const KEENABLE_SEARCH_PATH = "/v1/search";
/** The keyless search operation; requires the `X-Keenable-Title` header. */
const KEENABLE_PUBLIC_SEARCH_PATH = "/v1/search/public";
/** The keyed fetch operation appended to the base URL. */
const KEENABLE_FETCH_PATH = "/v1/fetch";
/** The keyless fetch operation; requires the `X-Keenable-Title` header. */
const KEENABLE_PUBLIC_FETCH_PATH = "/v1/fetch/public";
/** Default retrieval mode: deeper retrieval. */
const KEENABLE_DEFAULT_MODE = "pro";
/** Application name sent on keyless calls; Keenable rejects the public endpoints without it. */
const KEENABLE_DEFAULT_APP_TITLE = "deepseek-harness";
/** Default `max_chars` per fetched page (Keenable's own default). */
const KEENABLE_DEFAULT_MAX_CHARS = 50000;
/** Largest `max_chars` the schema accepts, and so the largest body this provider asks for. */
const KEENABLE_MAX_CHARS_LIMIT = 200000;
/** Longest accepted request URL; Keenable's own limit is 2048 characters. */
const KEENABLE_MAX_URL_LENGTH = 2048;
/**
 * Whether a fetch pulls the live source (Keenable's `live=true`) instead of
 * the indexed copy. Defaults to `true` because this provider replaces the
 * local HTTP fetcher, which always reads the live source; the indexed copy
 * fails for URLs Keenable has not indexed.
 */
const KEENABLE_DEFAULT_LIVE = true;
/** Keenable's accepted `snippet_max_length` bounds (characters). */
const KEENABLE_MIN_SNIPPET_LENGTH = 180;
const KEENABLE_MAX_SNIPPET_LENGTH = 10000;
/** Keenable's accepted `max_results` upper bound; the seam still caps on return. */
const KEENABLE_MAX_RESULTS = 50;
/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search-keenable/1.0.12";
/** Launch-environment variable naming the Keenable API key credential. */
const KEENABLE_API_KEY_ENV = "KEENABLE_API_KEY";
/**
 * The trimmed string when it is non-blank, else `undefined`.
 *
 * A config field the user blanked out must fall through to the next source —
 * the launch environment, then the constant — rather than send an empty header
 * Keenable would reject.
 */
function nonblank(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/**
 * Return the first non-blank string among `values`, or `undefined`.
 *
 * Keenable results may carry only one of `snippet` or `description`, and either
 * may be present but blank, so the mapping treats blank text as absent.
 */
function firstNonBlank(...values) {
	for (const value of values) {
		if (value != null && value.trim().length > 0) return value;
	}
	return void 0;
}
/**
 * Normalize one Keenable result URL to a portable web URL, or `undefined`.
 *
 * Only an http(s) URL without embedded credentials is kept: the seam serves
 * this URL to the model and to `web_fetch`, and a URL the fetcher would refuse
 * has no use here. The normalized `href` is returned so two spellings of the
 * same page dedupe as one.
 */
function normalizeWebUrl(value) {
	if (typeof value !== "string" || !URL.canParse(value)) return void 0;
	const url = new URL(value);
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return void 0;
	return url.href;
}
/**
 * Map one Keenable result to a normalized source, or `undefined` when it
 * carries no portable snippet (an entry with neither a non-blank `snippet` nor
 * a non-blank `description` is dropped — the seam has no other field to derive
 * a snippet from, and inventing one would lie).
 *
 * `snippet_max_length` is a hint the API may exceed slightly, so the excerpt
 * budget is enforced here as well: over-long text is cut and marked with an
 * ellipsis rather than passed through unshaped.
 *
 * @param result - one entry of Keenable's `results[]`.
 * @param maxSnippetChars - the excerpt budget, when the config names one.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank `snippet`/`description`.
 */
function mapKeenableResult(result, maxSnippetChars) {
	const url = normalizeWebUrl(result?.url);
	if (url === void 0) return void 0;
	const snippet = firstNonBlank(result.snippet, result.description);
	if (snippet === void 0) return void 0;
	return {
		url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		snippet: excerptSnippet(snippet, maxSnippetChars),
		...result.published_at != null && result.published_at.length > 0 ? { publishedAt: result.published_at } : {}
	};
}
/**
 * Collapse one excerpt to a single line and cut it to `maxChars`.
 *
 * Keenable puts the page text in `snippet` with its line breaks; the seam's
 * snippet is one line, so every run of whitespace becomes a space. An over-long
 * excerpt is cut one character short of the budget and marked with an ellipsis,
 * so the model sees that text was removed.
 */
function excerptSnippet(text, maxChars) {
	const line = text.replace(/\s+/gu, " ");
	if (maxChars === void 0 || line.length <= maxChars) return line;
	return `${line.slice(0, maxChars - 1).trimEnd()}…`;
}
/**
 * Map a Keenable response envelope to a normalized search result.
 *
 * Entries whose URL is unusable, or that carry no non-blank
 * `snippet`/`description`, are dropped ({@link mapKeenableResult}), as are
 * duplicates of a URL already kept — two spellings of the same page are one
 * source, and repeating it would spend the model's context twice.
 *
 * @param response - the parsed `POST /v1/search` (or `/v1/search/public`) body.
 * @param maxSnippetChars - the excerpt budget, when the config names one.
 * @returns the normalized result; unusable entries are dropped.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when `results` is not an array.
 */
function mapKeenableResponse(response, maxSnippetChars) {
	if (!Array.isArray(response?.results)) {
		throw new WebError("Keenable returned an unprocessable response body: response.results is not an array", "WEB_PROVIDER_ERROR");
	}
	const seen = new Set();
	const sources = [];
	for (const result of response.results) {
		const source = mapKeenableResult(result, maxSnippetChars);
		if (source === void 0 || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
	}
	return {
		sources,
		truncated: false
	};
}
/**
 * Map a Keenable fetch response envelope to a normalized fetch result.
 *
 * Keenable returns the page as markdown, which the seam classifies as `text`.
 * The envelope carries no target-page status code, so a successful call maps to
 * `200` — an unreachable or unextractable page surfaces as a Keenable API
 * error instead. Keenable's `max_chars` is a soft cap (it may return somewhat
 * more), so the provider slices `content` to `maxChars` itself — the same
 * discipline the local HTTP fetcher applies — and flags `truncated` only when
 * it actually cut. A response without page text is a failure, not an empty
 * success: the model would otherwise be told it read a page it never saw.
 * Keenable also returns the page title separately, often absent from `content`,
 * so it is prepended as a heading when the text does not already open with it.
 *
 * @param response - the parsed `GET /v1/fetch` (or `/v1/fetch/public`) body.
 * @param requestUrl - the URL the request asked for, used when the envelope
 *   carries none.
 * @param maxChars - the `max_chars` the request sent, for truncation inference.
 * @returns the normalized fetch result.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when `content` is not a string.
 */
function mapKeenableFetch(response, requestUrl, maxChars) {
	if (typeof response?.content !== "string") {
		throw new WebError("Keenable returned an unprocessable response body: response.content is not a string", "WEB_PROVIDER_ERROR");
	}
	const title = firstNonBlank(response.title);
	const raw = title !== void 0 && !response.content.slice(0, 300).includes(title) ? `# ${title}\n\n${response.content}` : response.content;
	const truncated = maxChars !== void 0 && raw.length > maxChars;
	return {
		url: response.url != null && response.url.length > 0 ? response.url : requestUrl,
		statusCode: 200,
		body: {
			kind: "text",
			content: truncated ? raw.slice(0, maxChars) : raw
		},
		truncated
	};
}
/**
 * Describe a non-2xx Keenable response as one message, best effort.
 *
 * The body is read once as text so both the `{ error, message }` JSON envelope
 * and a plain-text failure stay readable; an aborted read surfaces as
 * `WEB_ABORTED` like every other cancellation in this package. A rate limit on
 * the keyless pool names the way out, because the message the model sees is the
 * only help the operator gets.
 */
async function describeKeenableError(response, keyless) {
	const fallback = `Keenable API error (HTTP ${response.status})`;
	let text;
	try {
		text = await response.text();
	} catch (error) {
		if (isAbortError(error)) throw new WebError("Keenable request aborted", "WEB_ABORTED", { cause: error });
		return fallback;
	}
	const trimmed = text.trim();
	let message = trimmed.length === 0 ? fallback : trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		const detail = parsed?.error ?? parsed?.message;
		if (detail != null && detail.length > 0) message = detail;
	} catch {
	}
	if (response.status === 429 && keyless) {
		message += " (keyless requests share a per-IP limit; set the plugin's apiKey or KEENABLE_API_KEY to lift it)";
	}
	return message;
}
/**
 * Parse and policy-check one fetch request URL before any network call.
 *
 * Only http(s) URLs reach Keenable; anything else is a request-shape error,
 * not a provider failure. Keenable refuses a request URL past 2048 characters,
 * and a credential-carrying URL would ask Keenable to authenticate somewhere
 * on the user's behalf, so both are rejected locally rather than reported as a
 * provider failure.
 *
 * @param input - the URL a fetch requested.
 * @returns the parsed URL.
 * @throws {@link WebError} `WEB_INVALID_URL` when the URL must not be fetched.
 */
function parseFetchUrl(input) {
	if (typeof input !== "string" || input.length > KEENABLE_MAX_URL_LENGTH) {
		throw new WebError(`URL exceeds the ${KEENABLE_MAX_URL_LENGTH}-character limit`, "WEB_INVALID_URL");
	}
	if (!URL.canParse(input)) throw new WebError(`invalid URL: ${input}`, "WEB_INVALID_URL");
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, "WEB_INVALID_URL");
	}
	if (url.username || url.password) {
		throw new WebError("URL must not carry embedded credentials", "WEB_INVALID_URL");
	}
	return url;
}
/** The Keenable-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var KeenableSearchProvider = class {
	resolveOptions;
	id = "keenable";
	/**
	 * @param resolveOptions - a thunk snapshotted once at each operation's
	 *   entry, so one search never mixes two config sections and a settings
	 *   change reaches the next call without re-registering the provider —
	 *   a re-registration would make the seam's selection observable to the
	 *   user as a flicker.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		const options = this.resolveOptions();
		return isValidBaseUrl(options.baseURL) && (options.maxResults === void 0 || isPositiveInteger(options.maxResults)) && (options.snippetMaxLength === void 0 || isValidSnippetLength(options.snippetMaxLength));
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await resolveApiKeyFor(options, "search");
		const keyed = apiKey.length > 0;
		const requested = request.maxResults ?? options.maxResults;
		const maxResults = requested === void 0 ? void 0 : clampResultCount(requested);
		const snippetMaxLength = options.snippetMaxLength !== void 0 ? clampSnippetLength(options.snippetMaxLength) : void 0;
		let response;
		try {
			response = await fetch(endpointOf(options.baseURL, keyed ? KEENABLE_SEARCH_PATH : KEENABLE_PUBLIC_SEARCH_PATH), {
				method: "POST",
				redirect: "error",
				headers: this.headers(options, apiKey),
				body: JSON.stringify({
					query: request.query,
					mode: options.mode,
					...maxResults !== void 0 ? { max_results: maxResults } : {},
					...snippetMaxLength !== void 0 ? { snippet_max_length: snippetMaxLength } : {},
					...options.site !== void 0 ? { site: options.site } : {}
				}),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error, signal)) throw new WebError("Keenable search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Keenable search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			throw new WebError(await describeKeenableError(response, !keyed), "WEB_PROVIDER_ERROR");
		}
		try {
			return mapKeenableResponse(await response.json(), options.snippetMaxLength);
		} catch (error) {
			if (isAbortError(error, signal)) throw new WebError("Keenable search aborted", "WEB_ABORTED", { cause: error });
			if (error instanceof WebError) throw error;
			throw new WebError(`Keenable returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	/**
	 * Request headers for one operation. The attribution title rides every
	 * request, not only the keyless ones: the keyed endpoints accept it, and it
	 * is what attributes this traffic to the plugin.
	 */
	headers(options, apiKey) {
		return {
			...apiKey.length > 0 ? { "x-api-key": apiKey } : {},
			"content-type": "application/json",
			accept: "application/json",
			"x-keenable-title": options.appTitle,
			"user-agent": USER_AGENT
		};
	}
};
/** The Keenable-backed fetch provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var KeenableFetchProvider = class {
	resolveOptions;
	id = "keenable";
	/**
	 * @param resolveOptions - a thunk snapshotted once at each operation's
	 *   entry; see {@link KeenableSearchProvider}.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		const options = this.resolveOptions();
		return isValidBaseUrl(options.baseURL) && isPositiveInteger(options.maxChars) && options.maxChars < KEENABLE_MAX_CHARS_LIMIT;
	}
	async fetch(request, signal) {
		const options = this.resolveOptions();
		const target = parseFetchUrl(request.url);
		const apiKey = await resolveApiKeyFor(options, "fetch");
		const keyed = apiKey.length > 0;
		const url = new URL(endpointOf(options.baseURL, keyed ? KEENABLE_FETCH_PATH : KEENABLE_PUBLIC_FETCH_PATH));
		url.searchParams.set("url", target.toString());
		// One character more than the budget is asked for, so a page longer
		// than the budget is detected and flagged as truncated.
		url.searchParams.set("max_chars", String(options.maxChars + 1));
		url.searchParams.set("live", String(options.live));
		let response;
		try {
			response = await fetch(url, {
				method: "GET",
				redirect: "error",
				headers: {
					...keyed ? { "x-api-key": apiKey } : {},
					accept: "application/json",
					"x-keenable-title": options.appTitle,
					"user-agent": USER_AGENT
				},
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error, signal)) throw new WebError("Keenable fetch aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Keenable fetch request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			throw new WebError(await describeKeenableError(response, !keyed), "WEB_PROVIDER_ERROR");
		}
		try {
			return mapKeenableFetch(await response.json(), target.toString(), options.maxChars);
		} catch (error) {
			if (isAbortError(error, signal)) throw new WebError("Keenable fetch aborted", "WEB_ABORTED", { cause: error });
			if (error instanceof WebError) throw error;
			throw new WebError(`Keenable returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/**
 * True when `baseURL` parses as an HTTPS URL with no credentials, query or
 * fragment: the provider's own endpoint, so a value that could smuggle
 * parameters or userinfo is a configuration error, not a working origin.
 */
function isValidBaseUrl(baseURL) {
	if (typeof baseURL !== "string" || !URL.canParse(baseURL)) return false;
	const url = new URL(baseURL);
	return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}
/** Strip one trailing slash so `baseURL` + path never yields `//`. */
function endpointOf(baseURL, path) {
	return `${baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL}${path}`;
}
/** True for a result-count control Keenable accepts (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/** True for a `snippet_max_length` within Keenable's accepted bounds. */
function isValidSnippetLength(value) {
	return Number.isInteger(value) && value >= KEENABLE_MIN_SNIPPET_LENGTH && value <= KEENABLE_MAX_SNIPPET_LENGTH;
}
/**
 * Clamp a requested result count into Keenable's accepted 1..50 range.
 *
 * Keenable rejects an out-of-range `max_results`, and a request that names a
 * larger count is a cost preference rather than a hard requirement — the seam
 * still enforces the caller's own bound on the way back.
 */
function clampResultCount(value) {
	return Math.min(KEENABLE_MAX_RESULTS, Math.max(1, Math.round(value)));
}
/** Clamp a snippet length into Keenable's accepted 180..10000 range. */
function clampSnippetLength(value) {
	return Math.min(KEENABLE_MAX_SNIPPET_LENGTH, Math.max(KEENABLE_MIN_SNIPPET_LENGTH, Math.round(value)));
}
/**
 * True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`.
 *
 * An aborted signal settles every error raised after it, and a cancellation
 * is not always a `DOMException` named `AbortError` — a tool timeout may
 * attach its own reason — so the signal itself is asked first.
 */
function isAbortError(error, signal) {
	if (signal?.aborted === true) return true;
	return typeof error === "object" && error !== null && error.name === "AbortError";
}
/**
 * Resolve the API key one operation sends, or fail with guidance.
 *
 * `available()` is a purely local check, so the seam can dispatch an operation
 * whose key has since been removed; this closes that race and names every
 * place a key can come from. A resolution failure is a provider error, not a
 * bare rejection the seam would misclassify.
 *
 * @param options - the provider's shared credential access.
 * @param operation - `search` or `fetch`, named in the failure.
 * @returns the resolved key, or `''` for the keyless endpoints.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when resolution itself fails.
 */
async function resolveApiKeyFor(options, operation) {
	try {
		return (await options.resolveApiKey()) ?? "";
	} catch (error) {
		throw new WebError(`Keenable ${operation} could not read ${options.apiKeyEnv}: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
	}
}
/**
 * Create the API-key access both providers share.
 *
 * A non-empty literal `apiKey` wins; otherwise the key resolves through the
 * credentials service — the provider-managed store first, then ambient
 * fallbacks such as the process environment — or, when no credentials service
 * is mounted, straight from the launch environment. Resolution is asynchronous
 * and runs per operation, so a key saved or changed after startup reaches the
 * next call without a restart.
 *
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param options - thunks reading the live literal key and the credential reference name.
 * @returns the per-operation resolver.
 */
function createApiKeyAccess(ctx, options) {
	return {
		resolveApiKey: async () => {
			const literal = options.literal();
			if (literal !== void 0) return literal;
			const envName = options.envName();
			const ref = isCredentialRefName(envName) ? credentialRef(envName) : void 0;
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) {
				if (ref === void 0) return void 0;
				return (await credentials.resolve(ref))?.value;
			}
			const ambient = launchEnvironmentOf(ctx).get(envName);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		}
	};
}
/**
 * Keenable-backed `ctx.web` plugin. It registers a search provider and a fetch
 * provider into the web seam without owning the service; both share the same
 * credential resolution (a literal key, the credentials service, or the launch
 * environment — and an app title for the keyless endpoints).
 *
 * @module @lliangworld/dsh-web-search-keenable
 */
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-keenable";
/**
 * The web seam this provider registers into, plus the credentials plane.
 * Declaring `credentials` makes Cordis hold this fiber PENDING until the
 * credentials service is active — its `Service.init` awaits the store load —
 * so `apply()` never races a not-yet-mounted credential plane. Compositions
 * without a credentials service (e.g. the sdk-minimal template) keep this
 * plugin unloaded instead of degrading to the launch environment.
 */
const inject = ["web", "credentials"];
const Config = z.object({
	apiKey: z.string().role("secret").volatile().description("Keenable API key. Without one, both capabilities use the keyless public endpoints, limited to 10 requests per second and 1,000 per hour per IP address. Falls back to the KEENABLE_API_KEY credential: a key saved on the Plugins page, or the environment."),
	apiKeyEnv: z.string().role("credential-ref").default(KEENABLE_API_KEY_ENV).volatile().description("Name of the credential reference the API key resolves through when the config names no key: the credentials service first, then the launch environment."),
	baseURL: z.string().default(KEENABLE_DEFAULT_BASE_URL).volatile().description("Keenable API origin. HTTPS only; /v1/search and /v1/fetch (keyed) or their /public twins (keyless) are appended."),
	mode: z.union([
		"pro",
		"realtime"
	]).default(KEENABLE_DEFAULT_MODE).volatile().description("Search retrieval mode: pro (deeper retrieval) or realtime (fastest)."),
	appTitle: z.string().volatile().description("Application name sent as the X-Keenable-Title header, which the keyless endpoints require and every request uses for attribution. Defaults to the KEENABLE_APP_TITLE launch variable, then deepseek-harness."),
	site: z.string().volatile().description("Restrict search results to one site, such as techcrunch.com. Leave unset for no filter."),
	maxResults: z.number().step(1).min(1).max(KEENABLE_MAX_RESULTS).volatile().description("Search result count used when a request names none. A request's own count wins; a larger value is clamped into Keenable's accepted range."),
	snippetMaxLength: z.number().step(1).min(KEENABLE_MIN_SNIPPET_LENGTH).max(KEENABLE_MAX_SNIPPET_LENGTH).volatile().description("Excerpt length per search result in characters, sent as Keenable's snippet_max_length. Keenable treats it as a hint, so the provider enforces the same budget on the way back."),
	maxChars: z.number().step(1).min(1).max(KEENABLE_MAX_CHARS_LIMIT - 1).default(KEENABLE_DEFAULT_MAX_CHARS).volatile().description("Maximum characters of page text web_fetch returns, sent as Keenable's max_chars. Longer pages are cut and marked as truncated."),
	live: z.boolean().default(KEENABLE_DEFAULT_LIVE).volatile().description("Fetch pages live from the source. When off, web_fetch returns Keenable's indexed copy and fails for pages it has not indexed.")
});
/** A non-empty literal key, or `undefined` so resolution falls through. */
function literalApiKey(value) {
	return value !== void 0 && value.length > 0 ? value : void 0;
}
/**
 * Project the live config into the options the providers serve their next
 * operation with. Every field is read through its volatile reference, so a
 * config change reaches the next call without re-registering the providers —
 * a re-registration would make the seam's selection observable to the user
 * as a flicker. Environment fallbacks stay here rather than in the
 * providers: every value they read is already fully defaulted.
 *
 * @param ctx - plugin context supplying the environment plane.
 * @param config - the live config; each field is a volatile reference.
 * @param apiKeyAccess - the credential access both providers share.
 * @returns options for one operation.
 */
function resolveOptions(ctx, config, apiKeyAccess) {
	const mode = config.mode.get();
	const maxResults = config.maxResults.get();
	const snippetMaxLength = config.snippetMaxLength.get();
	const site = config.site.get();
	const appTitle = nonblank(config.appTitle.get()) ?? nonblank(launchEnvironmentOf(ctx).get("KEENABLE_APP_TITLE")?.value) ?? KEENABLE_DEFAULT_APP_TITLE;
	return {
		...apiKeyAccess,
		apiKeyEnv: config.apiKeyEnv.get() ?? KEENABLE_API_KEY_ENV,
		baseURL: config.baseURL.get() ?? KEENABLE_DEFAULT_BASE_URL,
		appTitle,
		mode: mode ?? KEENABLE_DEFAULT_MODE,
		...maxResults !== void 0 ? { maxResults } : {},
		...snippetMaxLength !== void 0 ? { snippetMaxLength } : {},
		...site !== void 0 ? { site } : {},
		maxChars: config.maxChars.get(),
		live: config.live.get()
	};
}
/**
 * Register the Keenable search and fetch providers with `ctx.web`.
 *
 * With a key both call the keyed endpoints; without one they call the keyless
 * public endpoints, which need an application title for their
 * `X-Keenable-Title` header (`appTitle`, then `$KEENABLE_APP_TITLE`, then a
 * constant). The key itself resolves per operation — a literal `apiKey` first,
 * then the `KEENABLE_API_KEY` credential reference (credentials service, then
 * launch environment) — so a key stored or changed after startup reaches the
 * next call without a restart. Every config field is volatile, so the same
 * holds for endpoint, mode, and limit changes: the loader commits them into the
 * running references instead of restarting the plugin.
 */
function apply(ctx, config) {
	const apiKeyAccess = createApiKeyAccess(ctx, {
		literal: () => literalApiKey(config.apiKey.get()),
		envName: () => config.apiKeyEnv.get() ?? KEENABLE_API_KEY_ENV
	});
	ctx.web.registerSearchProvider(new KeenableSearchProvider(() => resolveOptions(ctx, config, apiKeyAccess)));
	ctx.web.registerFetchProvider(new KeenableFetchProvider(() => resolveOptions(ctx, config, apiKeyAccess)));
}
export { Config, KEENABLE_DEFAULT_APP_TITLE, KEENABLE_DEFAULT_BASE_URL, KEENABLE_DEFAULT_LIVE, KEENABLE_DEFAULT_MAX_CHARS, KEENABLE_DEFAULT_MODE, KEENABLE_FETCH_PATH, KEENABLE_MAX_CHARS_LIMIT, KEENABLE_MAX_RESULTS, KEENABLE_MAX_SNIPPET_LENGTH, KEENABLE_MAX_URL_LENGTH, KEENABLE_MIN_SNIPPET_LENGTH, KEENABLE_PROVIDER_ID, KEENABLE_PUBLIC_FETCH_PATH, KEENABLE_PUBLIC_SEARCH_PATH, KEENABLE_SEARCH_PATH, KeenableFetchProvider, KeenableSearchProvider, apply, inject, name };
