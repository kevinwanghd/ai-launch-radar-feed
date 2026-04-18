#!/usr/bin/env python3
"""
X (Twitter) search via twscrape with curl_cffi patch.
Bypasses x-client-transaction-id generation issue by:
1. Using curl_cffi (Chrome TLS fingerprint) to fetch x.com pages
2. Extracting ondemand.s chunk URL from page HTML directly
3. Patching XClIdGen.create to use this method

Requires: pip install twscrape curl_cffi beautifulsoup4 fake_useragent

Usage:
  X_AUTH_TOKEN=xxx X_CT0=yyy python x_search.py "just launched AI tool" 20
"""
import asyncio
import base64
import os
import re
import sys

import bs4
from curl_cffi import requests as cffi_req
import twscrape.xclid as xclid_module
from twscrape import API, AccountsPool

# ---- Configuration ----
AUTH_TOKEN = os.environ.get("X_AUTH_TOKEN", "")
CT0 = os.environ.get("X_CT0", "")
PROXY = os.environ.get("HTTPS_PROXY", "http://127.0.0.1:8890")
DB_FILE = os.path.join(os.environ.get("TEMP", "/tmp"), "twscrape_xsearch.db")

INDICES_REGEX = re.compile(r"(\(\w{1}\[(\d{1,2})\],\s*16\))+", flags=(re.VERBOSE | re.MULTILINE))


def cffi_get(url):
    r = cffi_req.get(url, proxies={"https": PROXY, "http": PROXY},
                     impersonate="chrome", allow_redirects=True, timeout=20)
    r.raise_for_status()
    return r.text


def get_ondemand_s_text(page_text):
    """Extract and fetch ondemand.s JS from page HTML."""
    m = re.search(r'(\d+):"ondemand\.s"', page_text)
    if not m:
        raise Exception("ondemand.s chunk ID not found in page")
    chunk_id = m.group(1)
    m2 = re.search(rf'{chunk_id}:"([a-f0-9]+)"', page_text)
    if not m2:
        raise Exception(f"Hash for chunk {chunk_id} not found")
    chunk_hash = m2.group(1)
    for suffix in ["a", ""]:
        url = f"https://abs.twimg.com/responsive-web/client-web/ondemand.s.{chunk_hash}{suffix}.js"
        r = cffi_req.get(url, proxies={"https": PROXY}, impersonate="chrome", timeout=15)
        if r.status_code == 200:
            return r.text
    raise Exception("Could not fetch ondemand.s JS")


def build_xclient_gen(page_text):
    """Build XClIdGen using curl_cffi, bypassing broken get_scripts_list."""
    soup = bs4.BeautifulSoup(page_text, "html.parser")

    el = soup.find("meta", {"name": "twitter-site-verification", "content": True})
    if not el:
        raise Exception("twitter-site-verification not found")
    vk_bytes = list(base64.b64decode(bytes(str(el.get("content")), "utf-8")))

    els = list(soup.select("svg[id^='loading-x-anim'] g:first-child path:nth-child(2)"))
    els = [str(x.get("d") or "").strip() for x in els]
    if not els:
        raise Exception("SVG animation paths not found")

    ondemand_text = get_ondemand_s_text(page_text)
    items = [int(x.group(2)) for x in INDICES_REGEX.finditer(ondemand_text)]
    if not items:
        raise Exception("INDICES_REGEX found no matches in ondemand.s")

    anim_idx = items
    frame_time = 1
    for x in anim_idx[1:]:
        frame_time *= vk_bytes[x] % 16

    frame_idx = vk_bytes[anim_idx[0]] % 16
    idx2 = vk_bytes[5] % len(els)
    dat = els[idx2][9:].split("C")
    arr = [list(map(float, re.sub(r"[^\d]+", " ", x).split())) for x in dat]
    frame_row = arr[frame_idx]
    frame_dur = float(frame_time) / 4096

    anim_key = xclid_module.cacl_anim_key(frame_row, frame_dur)
    return xclid_module.XClIdGen(vk_bytes, anim_key)


async def patched_xclidgen_create(clt=None):
    page_text = cffi_get("https://x.com/tesla")
    return build_xclient_gen(page_text)


xclid_module.XClIdGen.create = staticmethod(patched_xclidgen_create)


async def search_x(query: str, limit: int = 20):
    if not AUTH_TOKEN or not CT0:
        print("ERROR: Set X_AUTH_TOKEN and X_CT0 environment variables", file=sys.stderr)
        sys.exit(1)

    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)

    pool = AccountsPool(db_file=DB_FILE)
    await pool.add_account(
        username="xsearch_account",
        password="unused",
        email="unused@example.com",
        email_password="unused",
        cookies=f"auth_token={AUTH_TOKEN}; ct0={CT0}",
        proxy=PROXY,
    )

    api = API(pool, proxy=PROXY)
    tweets = []

    async for tweet in api.search(query, limit=limit):
        tweets.append({
            "id": tweet.id,
            "date": str(tweet.date)[:10],
            "username": tweet.user.username,
            "text": tweet.rawContent,
            "likes": tweet.likeCount,
            "retweets": tweet.retweetCount,
            "replies": tweet.replyCount,
            "url": f"https://x.com/{tweet.user.username}/status/{tweet.id}",
        })

    return tweets


if __name__ == "__main__":
    import json
    query = sys.argv[1] if len(sys.argv) > 1 else "just launched AI tool"
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    tweets = asyncio.run(search_x(query, limit))
    # Use errors='replace' for Windows GBK console
    out = json.dumps(tweets, ensure_ascii=False, indent=2)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    print(f"\n# Total: {len(tweets)} tweets", file=sys.stderr)
