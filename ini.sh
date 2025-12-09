# Get a token first
TOKEN=$(curl -s -X POST http://localhost:3000/api/rooms/101/pairing-token | jq -r '.pairing_url' | grep -oP 'token=\K.*')

echo "Token: $TOKEN"

# Now "pair" with it
curl "http://localhost:3000/pair?token=$TOKEN"
