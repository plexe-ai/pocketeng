.PHONY: build deploy prod test

prod test:
	@true

deploy:
	@if echo "$(MAKECMDGOALS)" | grep -qw prod; then \
		echo "Deploying to PROD..."; \
	elif echo "$(MAKECMDGOALS)" | grep -qw test; then \
		echo "Deploying to TEST..."; \
	else \
		echo "Usage: make deploy prod  or  make deploy test"; \
		exit 1; \
	fi
	rm -rf .aws-sam || true
	sam build
	@if echo "$(MAKECMDGOALS)" | grep -qw test; then \
		sam deploy --force-upload --s3-prefix "deploy-$$(date +%s)" --config-file samconfig.test.toml; \
	else \
		sam deploy --force-upload --s3-prefix "deploy-$$(date +%s)"; \
	fi

build:
	rm -rf .aws-sam || true
	sam build
