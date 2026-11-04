import os
import requests

url = "https://freelancer-api.p.rapidapi.com/find-jobs"
# or
url = "https://freelancer-api.p.rapidapi.com/find-jobs/1"

# The key comes from the environment: never put it in this file.
#   PowerShell:  $env:RAPIDAPI_KEY = "<your key>"
headers = {
    "x-rapidapi-key": os.environ["RAPIDAPI_KEY"],
    "x-rapidapi-host": "freelancer-api.p.rapidapi.com"
}

r = requests.get(url, headers=headers)

print(r.status_code)
print(r.json())