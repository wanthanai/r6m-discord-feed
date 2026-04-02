const COMMUNITY_MAX_POST_AGE_SECONDS = 60 * 60 * 3;
const OFFICIAL_MAX_POST_AGE_SECONDS = 60 * 60 * 24 * 30;
const OFFICIAL_HOME_URL = "https://www.ubisoft.com/en-us/game/rainbow-six/mobile";
const OFFICIAL_ARTICLE_URL_RE =
  /\/en-us\/game\/rainbow-six\/mobile\/news-updates\/([A-Za-z0-9]+)(?:\/[A-Za-z0-9-]+)?/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run-feeds") {
      const summary = await runFeeds(env, { trigger: "http" });

      return new Response(JSON.stringify(summary, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response("R6M dual-feed worker is running", { status: 200 });
  },

  async scheduled(controller, env, ctx) {
    const trigger = {
      trigger: "scheduled",
      cron: controller.cron ?? null,
      scheduledTime: controller.scheduledTime ?? null,
    };

    logEvent("[worker] scheduled.triggered", trigger);
    ctx.waitUntil(runFeeds(env, trigger));
  },
};

async function runFeeds(env, trigger = {}) {
  const startedAt = Date.now();

  logEvent("[worker] feeds.start", trigger);

  const feeds = await Promise.all([
    sendCommunityFeed(env),
    sendOfficialFeed(env), // เปิดใช้หลังจากเราทำ official parser ต่อ
  ]);

  const summary = {
    ...trigger,
    durationMs: Date.now() - startedAt,
    totals: {
      feedsChecked: feeds.length,
      fetchedCount: sumBy(feeds, "fetchedCount"),
      sentCount: sumBy(feeds, "sentCount"),
      skippedCount: feeds.filter((feed) => feed.status === "skipped").length,
      errorCount: feeds.filter((feed) => feed.status === "error").length,
    },
    feeds,
  };

  logEvent("[worker] feeds.summary", summary);

  return summary;
}

/* =========================
   COMMUNITY FEED (Reddit)
   ========================= */
async function sendCommunityFeed(env) {
  const result = {
    feed: "community",
    source: "reddit",
    status: "skipped",
    reason: "unknown",
    fetchedCount: 0,
    sentCount: 0,
    latestId: null,
    lastSentId: null,
    postAgeSeconds: null,
  };

  try {
    logEvent("[community] start", {
      url: "https://www.reddit.com/r/Rainbow6Mobile/.json?limit=5",
    });

    const redditUrl = "https://www.reddit.com/r/Rainbow6Mobile/.json?limit=5";
    const res = await fetch(redditUrl, {
      headers: {
        "User-Agent": "BassR6MNewsBot/1.0 by Bass",
        "Accept": "application/json",
      },
    });

    logEvent("[community] reddit.response", { status: res.status });

    if (!res.ok) {
      result.status = "error";
      result.reason = "reddit_fetch_failed";
      result.httpStatus = res.status;
      logEvent("[community] end", result);
      return result;
    }

    const data = await res.json();
    const posts = data?.data?.children ?? [];
    result.fetchedCount = posts.length;

    if (!posts.length) {
      result.reason = "no_posts";
      logEvent("[community] end", result);
      return result;
    }

    const latest = posts[0]?.data;
    result.latestId = latest?.id ?? null;

    if (!latest?.id || !latest?.created_utc) {
      result.reason = "invalid_latest_post";
      logEvent("[community] end", result);
      return result;
    }

    const now = Math.floor(Date.now() / 1000);
    const postAge = now - latest.created_utc;
    result.postAgeSeconds = postAge;

    if (postAge > COMMUNITY_MAX_POST_AGE_SECONDS) {
      result.reason = "latest_post_too_old";
      logEvent("[community] end", result);
      return result;
    }

    const kvKey = "community_last_sent_post_id";
    const lastSentId = await env.NEWS_STATE.get(kvKey);
    result.lastSentId = lastSentId;

    if (lastSentId === latest.id) {
      result.reason = "latest_post_already_sent";
      logEvent("[community] end", result);
      return result;
    }

    if (!env.DISCORD_WEBHOOK_COMMUNITY) {
      result.status = "error";
      result.reason = "community_webhook_missing";
      logEvent("[community] end", result);
      return result;
    }

    const title = latest.title ?? "New community post";
    const permalink = latest.permalink
      ? `https://www.reddit.com${latest.permalink}`
      : "https://www.reddit.com/r/Rainbow6Mobile/";
    const author = latest.author ?? "unknown";
    let description = latest.selftext ? decodeHtml(latest.selftext).trim() : "";

    if (!description) description = "New community post from r/Rainbow6Mobile.";
    if (description.length > 300) description = description.slice(0, 297) + "...";

    const imageUrl = getPreviewImage(latest);

    const body = {
      username: "R6M Community Feed",
      embeds: [
        {
          title,
          url: permalink,
          description,
          color: 16753920,
          author: {
            name: `u/${author}`,
            url: `https://www.reddit.com/user/${author}/`,
          },
          footer: {
            text: "Community Feed • r/Rainbow6Mobile",
          },
          ...(imageUrl ? { image: { url: imageUrl } } : {}),
        },
      ],
    };

    const discordRes = await fetch(env.DISCORD_WEBHOOK_COMMUNITY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    logEvent("[community] discord.response", {
      status: discordRes.status,
      latestId: latest.id,
    });

    if (!discordRes.ok) {
      const text = await discordRes.text();
      result.status = "error";
      result.reason = "community_webhook_failed";
      result.httpStatus = discordRes.status;
      result.discordError = text;
      logEvent("[community] end", result);
      return result;
    }

    await env.NEWS_STATE.put(kvKey, latest.id);
    result.status = "sent";
    result.reason = "sent_latest_post";
    result.sentCount = 1;
    logEvent("[community] end", result);
    return result;
  } catch (error) {
    result.status = "error";
    result.reason = "unexpected_error";
    result.error = error?.message || String(error);
    logEvent("[community] end", result);
    return result;
  }
}

/* =========================
   OFFICIAL FEED (placeholder)
   ========================= */
async function sendOfficialFeed(env) {
  const result = {
    feed: "official",
    source: "ubisoft",
    status: "skipped",
    reason: "unknown",
    fetchedCount: 0,
    sentCount: 0,
    latestId: null,
    lastSentId: null,
    articleAgeSeconds: null,
    articleUrl: null,
  };

  try {
    logEvent("[official] start", {
      url: OFFICIAL_HOME_URL,
    });

    const officialHomeRes = await fetch(OFFICIAL_HOME_URL, {
      headers: {
        "User-Agent": "BassR6MNewsBot/1.0 by Bass",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    logEvent("[official] home.response", { status: officialHomeRes.status });

    if (!officialHomeRes.ok) {
      result.status = "error";
      result.reason = "official_home_fetch_failed";
      result.httpStatus = officialHomeRes.status;
      logEvent("[official] end", result);
      return result;
    }

    const officialHomeHtml = await officialHomeRes.text();
    const latestArticlePath = extractOfficialArticlePath(officialHomeHtml);

    if (!latestArticlePath) {
      result.status = "error";
      result.reason = "official_article_path_not_found";
      logEvent("[official] end", result);
      return result;
    }

    const latestIdMatch = latestArticlePath.match(OFFICIAL_ARTICLE_URL_RE);
    const latestId = latestIdMatch?.[1] ?? null;

    if (!latestId) {
      result.status = "error";
      result.reason = "official_article_id_not_found";
      result.articleUrl = latestArticlePath;
      logEvent("[official] end", result);
      return result;
    }

    result.latestId = latestId;
    result.fetchedCount = 1;
    result.articleUrl = latestArticlePath;

    const articleRes = await fetch(latestArticlePath, {
      headers: {
        "User-Agent": "BassR6MNewsBot/1.0 by Bass",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    logEvent("[official] article.response", {
      status: articleRes.status,
      latestId,
    });

    if (!articleRes.ok) {
      result.status = "error";
      result.reason = "official_article_fetch_failed";
      result.httpStatus = articleRes.status;
      logEvent("[official] end", result);
      return result;
    }

    const articleHtml = await articleRes.text();
    const article = parseOfficialArticle(articleHtml, latestArticlePath);

    if (!article.title || !article.url || !article.publishedAt) {
      result.status = "error";
      result.reason = "official_article_parse_failed";
      result.articleUrl = article.url || latestArticlePath;
      logEvent("[official] end", result);
      return result;
    }

    result.articleUrl = article.url;

    const articleAgeSeconds = Math.floor((Date.now() - article.publishedAt) / 1000);
    result.articleAgeSeconds = articleAgeSeconds;

    if (articleAgeSeconds > OFFICIAL_MAX_POST_AGE_SECONDS) {
      result.reason = "latest_article_too_old";
      logEvent("[official] end", result);
      return result;
    }

    const kvKey = "official_last_sent_post_id";
    const lastSentId = await env.NEWS_STATE.get(kvKey);
    result.lastSentId = lastSentId;

    if (lastSentId === latestId) {
      result.reason = "latest_article_already_sent";
      logEvent("[official] end", result);
      return result;
    }

    if (!env.DISCORD_WEBHOOK_OFFICIAL) {
      result.status = "error";
      result.reason = "official_webhook_missing";
      logEvent("[official] end", result);
      return result;
    }

    const description =
      article.description || "New official update from Rainbow Six Mobile.";
    const trimmedDescription =
      description.length > 300 ? `${description.slice(0, 297)}...` : description;

    const body = {
      username: "R6M Official Feed",
      embeds: [
        {
          title: article.title,
          url: article.url,
          description: trimmedDescription,
          color: 4897492,
          author: {
            name: "Ubisoft Official",
            url: OFFICIAL_HOME_URL,
          },
          footer: {
            text: "Official Feed • Rainbow Six Mobile",
          },
          timestamp: new Date(article.publishedAt).toISOString(),
          ...(article.imageUrl ? { image: { url: article.imageUrl } } : {}),
        },
      ],
    };

    const discordRes = await fetch(env.DISCORD_WEBHOOK_OFFICIAL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    logEvent("[official] discord.response", {
      status: discordRes.status,
      latestId,
    });

    if (!discordRes.ok) {
      const text = await discordRes.text();
      result.status = "error";
      result.reason = "official_webhook_failed";
      result.httpStatus = discordRes.status;
      result.discordError = text;
      logEvent("[official] end", result);
      return result;
    }

    await env.NEWS_STATE.put(kvKey, latestId);
    result.status = "sent";
    result.reason = "sent_latest_article";
    result.sentCount = 1;
    logEvent("[official] end", result);
    return result;
  } catch (error) {
    result.status = "error";
    result.reason = "unexpected_error";
    result.error = error?.message || String(error);
    logEvent("[official] end", result);
    return result;
  }
}

function logEvent(message, payload) {
  if (payload == null) {
    console.log(message);
    return;
  }

  console.log(message, JSON.stringify(payload));
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
}

function extractOfficialArticlePath(html) {
  const patterns = [
    /"buttonUrl":"(\/news-updates\/[A-Za-z0-9]+(?:\/[A-Za-z0-9-]+)?)"/,
    /href="(\/en-us\/game\/rainbow-six\/mobile\/news-updates\/[A-Za-z0-9]+(?:\/[A-Za-z0-9-]+)?)"/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (!match?.[1]) {
      continue;
    }

    if (match[1].startsWith("/news-updates/")) {
      return `${OFFICIAL_HOME_URL}${match[1]}`;
    }

    return `https://www.ubisoft.com${match[1]}`;
  }

  return null;
}

function parseOfficialArticle(html, fallbackUrl) {
  const canonicalUrl = extractMetaValue(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  const title =
    extractMetaValue(html, /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
    extractMetaValue(html, /<title[^>]*>([^<]+)<\/title>/i);
  const description =
    extractMetaValue(html, /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) ||
    extractMetaValue(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  const imageUrl = extractMetaValue(
    html,
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
  );
  const publishedAtRaw = extractMetaValue(html, /"date":"([^"]+)"/);
  const publishedAt = publishedAtRaw ? Date.parse(publishedAtRaw) : Number.NaN;

  return {
    title: title ? decodeHtml(title).trim() : null,
    description: description ? decodeHtml(description).trim() : null,
    imageUrl: imageUrl ? decodeHtml(imageUrl).trim() : null,
    url: canonicalUrl ? decodeHtml(canonicalUrl).trim() : fallbackUrl,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
  };
}

function extractMetaValue(html, pattern) {
  const match = html.match(pattern);
  return match?.[1] ?? null;
}

function getPreviewImage(post) {
  try {
    if (post.preview?.images?.length) {
      return decodeHtml(post.preview.images[0].source.url);
    }

    if (post.thumbnail && /^https?:\/\//.test(post.thumbnail)) {
      return post.thumbnail;
    }

    return null;
  } catch {
    return null;
  }
}

function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
