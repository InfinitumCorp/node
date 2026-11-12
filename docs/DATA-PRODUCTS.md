# Data products

Defined products, not a feed. Each is a separate licensed API. Potential markets, not confirmed buyers.

| Product | API | Buyers | Contents | Status |
|---|---|---|---|---|
| Connectivity reports | `GET /api/reports/connectivity?area=<geohash 3-5>&from&to` | ISPs, network planners, property operators | Per area-hour: median down/up Mbit/s, p90 latency, success rate, sessions (rounded) | Built |
| Venue activity | `GET /api/reports/venue-activity?hotspot&from&to` | Retailers, property managers (and the venue itself, free, in the app) | Sessions per hour at a business hotspot | Built |
| Consumer research | — | Brands, research firms | Answers to surveys people choose to take, each naming its sponsor | Consent purpose only |
| Campaign measurement | — | Advertisers, venues | Aggregated exposure/conversion | Consent purpose only |

Every response states `minGroup` and how many groups were `suppressed`. Keys are sent in `x-node-buyer-key`; only their SHA-256 is stored. Requests are logged with the buyer, query and row counts.

## Flow

Permission record → limited collection → aggregation and privacy checks → buyer license → revenue.

Quality samples and visits are only sent from the app when the person has turned on the matching purpose.
