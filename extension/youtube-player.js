// A YouTube video's data, read from the page's own world when the user clips the video:
// YouTube keeps the current video's player data (title, channel, description, caption
// tracks) there, not in the page's markup, which still holds the first video a tab opened.
// Nothing is fetched here; the clipping script requests the caption text itself.

// The id of the video a YouTube address shows (watch, shorts or live), or ''.
export function youtubeVideoId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || !/^(?:www\.|m\.)?youtube\.com$/.test(parsed.hostname))
    return '';
  const id =
    parsed.pathname === '/watch'
      ? parsed.searchParams.get('v')
      : /^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/.exec(parsed.pathname)?.[1];
  return /^[\w-]{11}$/.test(id || '') ? id : '';
}

// Runs in the page's main world through chrome.scripting (so it must not use anything from
// this module). Returns the player data of videoId, bounded, or null when the page shows
// another video. The page can change all of it; the clipping script checks it again.
export function youtubePlayerData(videoId) {
  const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
  const sources = [
    () => document.getElementById('movie_player')?.getPlayerResponse?.(),
    () => globalThis.ytInitialPlayerResponse,
  ];
  for (const source of sources) {
    let data;
    try {
      data = source();
    } catch {
      continue;
    }
    if (!data || data.videoDetails?.videoId !== videoId) continue;
    const details = data.videoDetails;
    const list = data.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(list?.captionTracks) ? list.captionTracks.slice(0, 100) : [];
    const thumbnails = Array.isArray(details.thumbnail?.thumbnails)
      ? details.thumbnail.thumbnails
      : [];
    const largest = thumbnails.reduce(
      (best, item) => ((Number(item?.width) || 0) > (Number(best?.width) || 0) ? item : best),
      null,
    );
    const microformat = data.microformat?.playerMicroformatRenderer || {};
    const name = (value) =>
      text(value?.simpleText, 200) ||
      (Array.isArray(value?.runs) ? value.runs.map((run) => text(run?.text, 200)).join('') : '');
    return {
      videoId,
      status: text(data.playabilityStatus?.status, 40),
      title: text(details.title, 500),
      author: text(details.author, 300),
      description: text(details.shortDescription, 100000),
      lengthSeconds: Number(details.lengthSeconds) || 0,
      thumbnail: text(largest?.url, 4096),
      publishDate: text(microformat.publishDate || microformat.uploadDate, 40),
      defaultTrack: Number(list?.audioTracks?.[0]?.defaultCaptionTrackIndex),
      tracks: tracks.map((track) => ({
        url: text(track?.baseUrl, 4096),
        language: text(track?.languageCode, 35),
        kind: track?.kind === 'asr' ? 'asr' : '',
        name: name(track?.name),
      })),
    };
  }
  return null;
}
