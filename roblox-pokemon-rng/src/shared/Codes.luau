--!strict
--[[
	Codes
	Promo codes. Redemption is validated and applied entirely on the server; this
	table is shared only so the client can normalise input before sending it.

	Set `expires` to a Unix timestamp to retire a code without deleting it (the
	list doubles as a changelog). nil means it never expires.
]]

export type Code = {
	code: string,
	coins: number?,
	potions: { string }?,
	expires: number?,
	note: string,
}

local Codes = {}

Codes.list = {
	{ code = "RELEASE", coins = 5000, potions = { "luck1" }, note = "Launch code" },
	{ code = "THANKS1K", coins = 10000, potions = { "luck2" }, note = "1,000 visits" },
	{ code = "SHINYHUNT", coins = 2500, potions = { "shiny1" }, note = "Variant weekend" },
	{ code = "PROFESSOR", coins = 15000, potions = { "luck2", "speed1" }, note = "Index update" },
} :: { Code }

Codes.byCode = {} :: { [string]: Code }
for _, entry in Codes.list do
	Codes.byCode[entry.code] = entry
end

--[[
	Codes are case-insensitive and tolerate stray whitespace, which is most of
	what players actually paste in.
]]
function Codes.normalise(input: string): string
	local trimmed = string.gsub(input, "%s", "")
	return string.upper(trimmed)
end

function Codes.get(input: string): Code?
	return Codes.byCode[Codes.normalise(input)]
end

function Codes.isActive(entry: Code, now: number): boolean
	return entry.expires == nil or now < entry.expires
end

return Codes
