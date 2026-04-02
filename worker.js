export default {
  async fetch(request, env, ctx) {
    return new Response("R6M dual-feed worker is running", { status: 200 });
  },

  async scheduled(controller, env, ctx) {
    console.log("scheduled event triggered");
    ctx.waitUntil(runFeeds(env));
  },
};

async function runFeeds(env) {
  await Promise.all([
    sendCommunityFeed(env),
    sendOfficialFeed(env), // เปิดใช้หลังจากเราทำ official parser ต่อ
  ]);
}

/* =========================
   COMMUNITY FEED (Reddit)
   ========================= */
async function sendCommunityFeed(env) {
  try {
    console.log("[community] start");

    const redditUrl = "https://www.reddit.com/r/Rainbow6Mobile/.json?limit=5";
    const res = await fetch(redditUrl, {
      headers: {
        "User-Agent": "BassR6MNewsBot/1.0 by Bass",
        "Accept": "application/json",
      },
    });

    console.log("[community] reddit status:", res.status);

    if (!res.ok) {
      console.log("[community] reddit failed:", res.status);
      return;
    }

    const data = await res.json();
    const posts = data?.data?.children ?? [];

    if (!posts.length) {
      console.log("[community] no posts");
      return;
    }

    const latest = posts[0]?.data;

    const now = Date.now() / 1000; // วินาที
const postAge = now - latest.created_utc;

// ถ้าโพสต์เกิน 10 นาที → ไม่ส่ง
if (postAge > 600) {
  console.log("[community] skip old post:", latest.id);
  return;
}

    if (!latest?.id) {
      console.log("[community] invalid latest post");
      return;
    }

    const kvKey = "community_last_sent_post_id";
    const lastSentId = await env.NEWS_STATE.get(kvKey);
    console.log("[community] lastSentId:", lastSentId);

    if (lastSentId === latest.id) {
      console.log("[community] no new post");
      return;
    }

    if (!env.DISCORD_WEBHOOK_COMMUNITY) {
      console.log("[community] DISCORD_WEBHOOK_COMMUNITY missing");
      return;
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

    console.log("[community] discord status:", discordRes.status);

    if (!discordRes.ok) {
      const text = await discordRes.text();
      console.log("[community] discord failed:", discordRes.status, text);
      return;
    }

    await env.NEWS_STATE.put(kvKey, latest.id);
    console.log("[community] saved:", latest.id);
  } catch (error) {
    console.log("[community] error:", error?.message || String(error));
  }
}

/* =========================
   OFFICIAL FEED (placeholder)
   ========================= */
async function sendOfficialFeed(env) {
  try {
    console.log("[official] start");

    if (!env.DISCORD_WEBHOOK_OFFICIAL) {
      console.log("[official] DISCORD_WEBHOOK_OFFICIAL missing");
      return;
    }

    // TODO:
    // ตรงนี้เราจะต่อ parser ข่าว official จาก Ubisoft ใน step ถัดไป
    console.log("[official] not implemented yet");
  } catch (error) {
    console.log("[official] error:", error?.message || String(error));
  }
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