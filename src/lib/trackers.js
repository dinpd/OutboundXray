// Recognises well-known companies behind tracking, advertising and hosting
// domains, and says in plain words what each kind of company does.
//
// The list is hand-written for this project (no third-party list is bundled,
// so there are no licence strings attached). Add entries as
// "domain|Product|category|Owner"; Owner defaults to Product. A domain also
// matches all of its subdomains.

import { registrableDomain } from './domains.js';
import { proxiedTracker } from './signatures.js';

export const CATEGORIES = {
  site:      { label: 'The website itself', weight: 0, plain: 'The site you are visiting, or a company that owns it.' },
  ads:       { label: 'Advertising', weight: 5, plain: 'Uses your visit to target and measure ads, often following you across many websites.' },
  replay:    { label: 'Session recording', weight: 5, plain: 'Records what you do on the page (mouse movement, clicks, scrolling, sometimes text) so the visit can be replayed later.' },
  marketing: { label: 'Marketing & sales', weight: 4, plain: 'Builds marketing profiles and may try to work out who you are or which company you work for.' },
  social:    { label: 'Social network', weight: 4, plain: 'Can link this visit to your social media account if you are logged in there.' },
  analytics: { label: 'Analytics', weight: 3, plain: 'Counts visits and measures how people use the site.' },
  security:  { label: 'Bot & fraud protection', weight: 2, plain: 'Checks that you are a real person, usually by examining your device and behaviour.' },
  payments:  { label: 'Payments & fraud checks', weight: 2, plain: 'Processes payments or checks for fraud, often collecting device details to do so.' },
  errors:    { label: 'Performance & error monitoring', weight: 2, plain: 'Reports crashes and slowness to the site’s developers. Reports can include details of your visit.' },
  support:   { label: 'Chat & support', weight: 2, plain: 'Runs a chat or help widget.' },
  tags:      { label: 'Tag manager', weight: 2, plain: 'Loads other tracking tools on behalf of the site.' },
  unseen:    { label: 'Address not seen', weight: 2, plain: 'The page used a connection that was already open when the scan started, so Chrome never said where it goes. Reload the page while scanning to see it.' },
  unknown:   { label: 'Not recognised', weight: 2, plain: 'A company OutboundXray does not recognise yet.' },
  consent:   { label: 'Cookie consent', weight: 1, plain: 'Shows the cookie banner and remembers your choice.' },
  cdn:       { label: 'Hosting & files', weight: 1, plain: 'Delivers files such as code, fonts, images or video. Mostly technical, but it still learns your IP address and which site you are on.' },
};

const RAW = `
google-analytics.com|Google Analytics|analytics|Google
analytics.google.com|Google Analytics|analytics|Google
app-measurement.com|Google Analytics for Firebase|analytics|Google
googletagmanager.com|Google Tag Manager|tags|Google
googletagservices.com|Google Ads|ads|Google
doubleclick.net|Google Ads (DoubleClick)|ads|Google
googlesyndication.com|Google AdSense|ads|Google
googleadservices.com|Google Ads|ads|Google
adservice.google.com|Google Ads|ads|Google
google.com|Google|ads|Google
googleapis.com|Google APIs & Fonts|cdn|Google
gstatic.com|Google static files|cdn|Google
youtube.com|YouTube|social|Google
youtube-nocookie.com|YouTube|cdn|Google
ytimg.com|YouTube|cdn|Google
googleusercontent.com|Google user files|cdn|Google
ggpht.com|Google user files|cdn|Google
gvt1.com|Google downloads|cdn|Google
recaptcha.net|Google reCAPTCHA|security|Google
facebook.com|Meta Pixel|ads|Meta (Facebook, Instagram)
facebook.net|Meta Pixel|ads|Meta (Facebook, Instagram)
fbcdn.net|Facebook files|cdn|Meta (Facebook, Instagram)
instagram.com|Instagram|social|Meta (Facebook, Instagram)
cdninstagram.com|Instagram files|cdn|Meta (Facebook, Instagram)
whatsapp.net|WhatsApp|social|Meta (Facebook, Instagram)
fbsbx.com|Facebook files|cdn|Meta (Facebook, Instagram)
messenger.com|Messenger|social|Meta (Facebook, Instagram)
threads.net|Threads|social|Meta (Facebook, Instagram)
meta.com|Meta|social|Meta (Facebook, Instagram)
clarity.ms|Microsoft Clarity|replay|Microsoft
bing.com|Microsoft Advertising (Bing)|ads|Microsoft
microsoft.com|Microsoft|cdn|Microsoft
adnxs.com|Microsoft Xandr|ads|Microsoft
linkedin.com|LinkedIn|social|Microsoft (LinkedIn)
licdn.com|LinkedIn|social|Microsoft (LinkedIn)
ads.linkedin.com|LinkedIn Ads|ads|Microsoft (LinkedIn)
tiktok.com|TikTok Pixel|ads|TikTok
tiktokw.us|TikTok Pixel|ads|TikTok
tiktokcdn.com|TikTok files|cdn|TikTok
ttwstatic.com|TikTok|ads|TikTok
byteoversea.com|TikTok|ads|TikTok
twitter.com|X (Twitter)|ads|X (Twitter)
x.com|X (Twitter)|ads|X (Twitter)
t.co|X (Twitter)|ads|X (Twitter)
ads-twitter.com|X (Twitter) Ads|ads|X (Twitter)
twimg.com|X (Twitter) files|cdn|X (Twitter)
pinterest.com|Pinterest|ads|Pinterest
pinimg.com|Pinterest|ads|Pinterest
snapchat.com|Snapchat Pixel|ads|Snap
sc-static.net|Snapchat Pixel|ads|Snap
reddit.com|Reddit Pixel|ads|Reddit
redditstatic.com|Reddit Pixel|ads|Reddit
redditmedia.com|Reddit files|cdn|Reddit
amazon-adsystem.com|Amazon Ads|ads|Amazon
amazonaws.com|Amazon Web Services|cdn|Amazon
cloudfront.net|Amazon CloudFront|cdn|Amazon
media-amazon.com|Amazon files|cdn|Amazon
ssl-images-amazon.com|Amazon files|cdn|Amazon
omtrdc.net|Adobe Analytics|analytics|Adobe
2o7.net|Adobe Analytics|analytics|Adobe
demdex.net|Adobe Audience Manager|ads|Adobe
everesttech.net|Adobe Advertising|ads|Adobe
adobedtm.com|Adobe Tag Manager|tags|Adobe
typekit.net|Adobe Fonts|cdn|Adobe
marketo.net|Adobe Marketo|marketing|Adobe
mktoresp.com|Adobe Marketo|marketing|Adobe
criteo.com|Criteo|ads
criteo.net|Criteo|ads
taboola.com|Taboola|ads
outbrain.com|Outbrain|ads
adsrvr.org|The Trade Desk|ads
rubiconproject.com|Magnite|ads
pubmatic.com|PubMatic|ads
openx.net|OpenX|ads
casalemedia.com|Index Exchange|ads
3lift.com|TripleLift|ads
sharethrough.com|Sharethrough|ads
lijit.com|Sovrn|ads
media.net|Media.net|ads
quantserve.com|Quantcast|ads
quantcount.com|Quantcast|ads
quantcast.com|Quantcast|ads
crwdcntrl.net|Lotame (data broker)|ads
rlcdn.com|LiveRamp (data broker)|ads
bluekai.com|Oracle BlueKai (data broker)|ads
id5-sync.com|ID5 (cross-site ID)|ads
liveintent.com|LiveIntent (email-based ad ID)|ads
tapad.com|Tapad (cross-device tracking)|ads
agkn.com|Neustar (data broker)|ads
mathtag.com|MediaMath|ads
bidswitch.net|BidSwitch|ads
smartadserver.com|Equativ (Smart AdServer)|ads
yieldmo.com|Yieldmo|ads
gumgum.com|GumGum|ads
kargo.com|Kargo|ads
teads.tv|Teads|ads
nativo.com|Nativo|ads
33across.com|33Across|ads
contextweb.com|PulsePoint|ads
connatix.com|Connatix (video ads)|ads
brightline.tv|Brightline (video ads)|ads
permutive.com|Permutive (audience data)|ads
permutive.app|Permutive (audience data)|ads|Permutive (audience data)
doubleverify.com|DoubleVerify (ad verification)|ads
adsafeprotected.com|Integral Ad Science (ad verification)|ads
moatads.com|Oracle Moat (ad verification)|ads
yahoo.com|Yahoo Ads|ads|Yahoo
yimg.com|Yahoo files|cdn|Yahoo
sharethis.com|ShareThis|ads
addthis.com|AddThis|ads
scorecardresearch.com|Comscore|analytics
chartbeat.com|Chartbeat|analytics
chartbeat.net|Chartbeat|analytics
parsely.com|Parse.ly|analytics
parse.ly|Parse.ly|analytics
hotjar.com|Hotjar|replay
hotjar.io|Hotjar|replay
fullstory.com|FullStory|replay
logrocket.com|LogRocket|replay
lr-ingest.io|LogRocket|replay
lr-in.com|LogRocket|replay
mouseflow.com|Mouseflow|replay
smartlook.com|Smartlook|replay
inspectlet.com|Inspectlet|replay
contentsquare.net|Contentsquare|replay
quantummetric.com|Quantum Metric|replay
luckyorange.com|Lucky Orange|replay
luckyorange.net|Lucky Orange|replay
crazyegg.com|Crazy Egg|replay
mixpanel.com|Mixpanel|analytics
mxpnl.com|Mixpanel|analytics
amplitude.com|Amplitude|analytics
segment.com|Segment (Twilio)|analytics
segment.io|Segment (Twilio)|analytics
heap.io|Heap|analytics
heapanalytics.com|Heap|analytics
posthog.com|PostHog|analytics
plausible.io|Plausible (privacy-friendly analytics)|analytics
usefathom.com|Fathom (privacy-friendly analytics)|analytics
matomo.cloud|Matomo|analytics
cloudflareinsights.com|Cloudflare Web Analytics|analytics|Cloudflare
yandex.ru|Yandex Metrica|analytics|Yandex
yandex.com|Yandex Metrica|analytics|Yandex
mediamelon.com|MediaMelon (video analytics)|analytics
cxense.com|Piano (Cxense)|analytics|Piano
piano.io|Piano|marketing
tinypass.com|Piano|marketing|Piano
qualtrics.com|Qualtrics (surveys)|analytics
medallia.com|Medallia (surveys)|analytics
optimizely.com|Optimizely (A/B testing)|analytics
visualwebsiteoptimizer.com|VWO (A/B testing)|analytics
launchdarkly.com|LaunchDarkly (feature flags)|analytics
statsig.com|Statsig (feature flags)|analytics
sentry.io|Sentry|errors
sentry-cdn.com|Sentry|errors
nr-data.net|New Relic|errors
newrelic.com|New Relic|errors
datadoghq.com|Datadog|errors
datadoghq.eu|Datadog|errors
bugsnag.com|Bugsnag|errors
rollbar.com|Rollbar|errors
hubspot.com|HubSpot|marketing
hs-analytics.net|HubSpot|marketing
hs-scripts.com|HubSpot|marketing
hsforms.com|HubSpot|marketing
hs-banner.com|HubSpot|marketing
pardot.com|Salesforce Pardot|marketing|Salesforce
salesforce.com|Salesforce|marketing|Salesforce
klaviyo.com|Klaviyo|marketing
braze.com|Braze|marketing
iterable.com|Iterable|marketing
customer.io|Customer.io|marketing
list-manage.com|Mailchimp|marketing|Intuit Mailchimp
chimpstatic.com|Mailchimp|marketing|Intuit Mailchimp
clearbit.com|Clearbit (identifies visitors' companies)|marketing
zoominfo.com|ZoomInfo (identifies visitors' companies)|marketing
6sc.co|6sense (identifies visitors' companies)|marketing
demandbase.com|Demandbase (identifies visitors' companies)|marketing
app.link|Branch|marketing
branch.io|Branch|marketing
appsflyer.com|AppsFlyer|marketing
adjust.com|Adjust|marketing
onesignal.com|OneSignal (push notifications)|marketing
intercom.io|Intercom|support
intercomcdn.com|Intercom|support
zendesk.com|Zendesk|support
zdassets.com|Zendesk|support
drift.com|Drift|support
crisp.chat|Crisp|support
tawk.to|tawk.to|support
livechatinc.com|LiveChat|support
helpscout.net|Help Scout|support
onetrust.com|OneTrust|consent
onetrust.io|OneTrust|consent|OneTrust
cookielaw.org|OneTrust|consent
cookiebot.com|Cookiebot|consent
trustarc.com|TrustArc|consent
usercentrics.eu|Usercentrics|consent
consensu.org|IAB consent framework|consent
didomi.io|Didomi|consent
datagrail.io|DataGrail|consent
stripe.com|Stripe|payments
stripe.network|Stripe (fraud detection)|payments|Stripe
paypal.com|PayPal|payments
paypalobjects.com|PayPal|payments|PayPal
braintreegateway.com|Braintree|payments|PayPal
adyen.com|Adyen|payments
hcaptcha.com|hCaptcha|security
challenges.cloudflare.com|Cloudflare Turnstile|security|Cloudflare
px-cdn.net|HUMAN (PerimeterX)|security
perimeterx.net|HUMAN (PerimeterX)|security
px-cloud.net|HUMAN (PerimeterX)|security|HUMAN (PerimeterX)
px-cdn.net|HUMAN (PerimeterX)|security|HUMAN (PerimeterX)
humansecurity.com|HUMAN (PerimeterX)|security|HUMAN (PerimeterX)
fpjs.io|Fingerprint (device fingerprinting)|security
fingerprint.com|Fingerprint (device fingerprinting)|security
cloudflare.com|Cloudflare|cdn|Cloudflare
jsdelivr.net|jsDelivr|cdn
unpkg.com|unpkg|cdn
fastly.net|Fastly|cdn
akamaihd.net|Akamai|cdn
akamaized.net|Akamai|cdn
fontawesome.com|Font Awesome|cdn
bootstrapcdn.com|Bootstrap CDN|cdn
jquery.com|jQuery CDN|cdn
imgix.net|imgix|cdn
shopify.com|Shopify (store platform)|cdn
shopifycdn.com|Shopify (store platform)|cdn|Shopify (store platform)
wp.com|WordPress.com|cdn|Automattic (WordPress)
gravatar.com|Gravatar|cdn|Automattic (WordPress)
googlevideo.com|YouTube video|cdn|Google
jwplayer.com|JW Player (video)|cdn
jwpcdn.com|JW Player (video)|cdn|JW Player (video)
brightcove.net|Brightcove (video)|cdn
vimeo.com|Vimeo|cdn
vimeocdn.com|Vimeo|cdn|Vimeo
disqus.com|Disqus|social
disquscdn.com|Disqus|social|Disqus
spotify.com|Spotify|cdn
`;

const COMPANIES = new Map();
for (const line of RAW.trim().split('\n')) {
  const [domain, product, category, owner] = line.split('|');
  COMPANIES.set(domain, { product, category, owner: owner || product });
}

export function lookupCompany(host) {
  let h = (host || '').toLowerCase();
  while (h) {
    const hit = COMPANIES.get(h);
    if (hit) return hit;
    const dot = h.indexOf('.');
    if (dot < 0) return null;
    h = h.slice(dot + 1);
  }
  return null;
}

// Decides who a request goes to, relative to the page you are on.
// "first" means the site itself, or a company that owns the site
// (e.g. Google Analytics on youtube.com). With `request` ({ url, bodyText }),
// a known tracker sent through an unrecognised domain, often the site's own,
// counts as that tracker's company, with `proxy` saying how it was spotted.
export function classify(host, pageHost, request) {
  const site = registrableDomain(host);
  const pageSite = registrableDomain(pageHost);
  const pageCompany = lookupCompany(pageHost);
  const sig = request && !lookupCompany(host) ? proxiedTracker(request.url, request.bodyText) : null;
  const company = sig ? lookupCompany(sig.domain) : lookupCompany(host);
  const sameOwner = !!(company && pageCompany && company.owner === pageCompany.owner);
  // A tracker spotted by its signature counts as its company even on the site's own domain.
  const first = sameOwner || (!sig && site === pageSite);
  return {
    site,
    party: first ? 'first' : 'third',
    company: company?.product || site,
    owner: company?.owner || site,
    category: first ? 'site' : (company?.category || 'unknown'),
    ...(sig && !first ? { proxy: { via: site, viaSite: site === pageSite, matched: sig.matched } } : {}),
  };
}
