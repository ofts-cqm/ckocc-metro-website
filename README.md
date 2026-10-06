# CKOCC Metro website workspace

The website implementation handoff is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

The current map is maintained separately in [ofts-cqm/ckocc-metro-map](https://github.com/ofts-cqm/ckocc-metro-map). Its local checkout is `map-data/`, with the editable document at `map-data/maps/network.json`, the original rendered image at `map-data/maps/network.png`, and their version metadata at `map-data/maps/manifest.json`.

`map-data/` is ignored by this website repository because it has its own Git history and remote. To recreate that checkout, run:

```sh
git clone https://github.com/ofts-cqm/ckocc-metro-map.git map-data
```

Local `.env` files and private keys are ignored. Keep them out of commits, screenshots, and issue descriptions.
