index.html: index.bs
	curl https://www.w3.org/publications/spec-generator/ -F file=@index.bs -F type=bikeshed-spec > index.html

check: index.bs
	curl https://www.w3.org/publications/spec-generator/ -F file=@index.bs -F type=bikeshed-spec -F output=messages
