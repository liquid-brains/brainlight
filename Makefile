all: dist

node_modules/.done: package.json package-lock.json
	rm -rf node_modules
	npm clean-install
	@touch node_modules/.done

node_modules: node_modules/.done
	@touch node_modules

dist/.done: $(shell find src -type f) node_modules
	rm -rf dist
	npm run tsc
	sed -i 's@/env ts-node@/env node@' dist/index.js
	chmod +x dist/index.js
	@touch dist/.done

dist: dist/.done
	@touch dist

clean:
	rm -rf dist

distclean: clean
	rm -rf node_modules

.PHONY: all clean distclean
