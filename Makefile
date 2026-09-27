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
	cp package.json dist/
	@touch dist/.done

dist: dist/.done
	@touch dist

test: node_modules
	npm test

do-npm-pack: dist
	rm -f dist/brainlight-*.tgz
	cd dist && npm pack
	tar -ztf dist/brainlight-*.tgz
	mv dist/brainlight-*.tgz .

clean:
	rm -rf dist
	rm -f brainlight-*.tgz

distclean: clean
	rm -rf node_modules

.PHONY: all clean distclean do-npm-pack test
