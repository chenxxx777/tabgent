// YouTube watch pages with the structure YouTube renders: the player element with its data
// in the page's own world (the markup's ytInitialPlayerResponse is an earlier video's, as
// after moving between videos), and the transcript panel; and caption files in YouTube's
// formats. Generated videos, ids and text.
const youtubeCues = (count, text, step = 3) =>
  Array.from({ length: count }, (_, i) => [i * step, step - 0.5, text(i)]);
const json3 = (cues) =>
  JSON.stringify({
    events: cues.map(([start, duration, text]) => ({
      tStartMs: Math.round(start * 1000),
      dDurationMs: Math.round(duration * 1000),
      segs: [{ utf8: text }],
    })),
  });
const srv3 = (cues) =>
  `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>${cues
    .map(([start, duration, text]) => `<p t="${start * 1000}" d="${duration * 1000}">${text}</p>`)
    .join('')}</body></timedtext>`;
function youtubePage(id, options = {}) {
  const {
    tracks = [],
    status = 'OK',
    description = '',
    panel = [],
    playerRequest = '',
    current = true,
  } = options;
  const response = {
    playabilityStatus: { status },
    videoDetails: {
      videoId: id,
      title: `Fixture video ${id.slice(-1)}`,
      author: 'Fixture Channel',
      lengthSeconds: '600',
      shortDescription: description,
      thumbnail: {
        thumbnails: [
          { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
          { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280, height: 720 },
        ],
      },
    },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-08-14T05:00:01-07:00' } },
    ...(tracks.length && {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: tracks.map(([language, kind, name]) => ({
            baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&caps=asr&exp=xpe&lang=${language}${kind ? '&kind=asr' : ''}&signature=FIXTURE`,
            name: { simpleText: name },
            vssId: `${kind ? 'a' : ''}.${language}`,
            languageCode: language,
            ...(kind && { kind }),
            isTranslatable: true,
          })),
          audioTracks: [
            { captionTrackIndices: tracks.map((_, i) => i), defaultCaptionTrackIndex: 0 },
          ],
        },
      },
    }),
  };
  const earlier = { videoDetails: { videoId: 'FIXTUREold0', title: 'An earlier video' } };
  const segments = panel
    .map(
      ([stamp, text]) =>
        `<ytd-transcript-segment-renderer><div class="segment"><div class="segment-start-offset"><div class="segment-timestamp">${stamp}</div></div><yt-formatted-string class="segment-text">${text}</yt-formatted-string></div></ytd-transcript-segment-renderer>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><title>Fixture video - YouTube</title></head><body>
  <ytd-app><div id="content"><ytd-watch-flexy video-id="${id}">
  <div id="player"><div id="movie_player" class="html5-video-player"><video></video></div></div>
  <div id="below"><h1 class="title">Fixture video</h1><a href="/@fixturechannel">Fixture Channel</a></div>
  ${segments && `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"><ytd-transcript-segment-list-renderer>${segments}</ytd-transcript-segment-list-renderer></ytd-engagement-panel-section-list-renderer>`}
  </ytd-watch-flexy></div></ytd-app>
  <script>var ytInitialPlayerResponse = ${JSON.stringify(earlier)};</script>
  <script>document.getElementById('movie_player').getPlayerResponse = () => (${JSON.stringify(current ? response : earlier)});
  ${playerRequest && `fetch(${JSON.stringify(playerRequest)}).catch(() => {});`}</script>
  </body></html>`;
}

module.exports = { youtubePage, youtubeCues, json3, srv3 };
