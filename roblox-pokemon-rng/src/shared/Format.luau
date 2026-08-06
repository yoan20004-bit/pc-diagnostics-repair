--!strict
--[[
	Format
	Display helpers. Rarity numbers in this game run from 1 to 10^8 and beyond
	once variants stack, so everything here has to stay readable at both ends.
]]

local Format = {}

local SUFFIXES = { "", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc" }

--[[
	1234 -> "1,234"
]]
function Format.comma(value: number): string
	local whole = string.format("%d", math.floor(value))
	local sign = ""
	if string.sub(whole, 1, 1) == "-" then
		sign = "-"
		whole = string.sub(whole, 2)
	end

	local out = whole
	while true do
		local replaced: number
		out, replaced = string.gsub(out, "^(%d+)(%d%d%d)", "%1,%2")
		if replaced == 0 then
			break
		end
	end
	return sign .. out
end

--[[
	1234 -> "1.23K". Used where space is tight (buttons, tiles).
]]
function Format.abbreviate(value: number, places: number?): string
	local decimals = places or 2
	if value ~= value or value == math.huge then
		return "inf"
	end

	local sign = value < 0 and "-" or ""
	local absolute = math.abs(value)
	if absolute < 1000 then
		return sign .. string.format("%d", math.floor(absolute))
	end

	local magnitude = math.floor(math.log(absolute, 1000))
	magnitude = math.clamp(magnitude, 1, #SUFFIXES - 1)

	local scaled = absolute / (1000 ^ magnitude)
	local text = string.format("%." .. decimals .. "f", scaled)
	-- Trim trailing zeros so we get "1.2K", not "1.20K".
	text = string.gsub(text, "%.?0+$", "")
	return sign .. text .. SUFFIXES[magnitude + 1]
end

--[[
	The headline rarity label. Below a million we spell the number out because
	"1 in 48,000" reads better than "1 in 48K"; above that, abbreviate.
]]
function Format.rarity(oneInN: number): string
	if oneInN == math.huge then
		return "1 in ?"
	end
	if oneInN < 1000000 then
		return "1 in " .. Format.comma(math.floor(oneInN + 0.5))
	end
	return "1 in " .. Format.abbreviate(oneInN)
end

--[[
	A luck multiplier, trimmed to however many decimals it actually needs.
]]
function Format.multiplier(value: number): string
	if value >= 100 then
		return Format.abbreviate(value) .. "x"
	end
	if value == math.floor(value) then
		return string.format("%dx", value)
	end
	local text = string.format("%.2f", value)
	text = string.gsub(text, "%.?0+$", "")
	return text .. "x"
end

--[[
	Seconds -> "4h 12m" / "12m 30s" / "9s". Used for potion timers and the daily
	reward countdown.
]]
function Format.duration(seconds: number): string
	if seconds <= 0 then
		return "0s"
	end

	local total = math.floor(seconds + 0.5)
	local hours = math.floor(total / 3600)
	local minutes = math.floor((total % 3600) / 60)
	local secs = total % 60

	if hours > 0 then
		return string.format("%dh %dm", hours, minutes)
	end
	if minutes > 0 then
		return string.format("%dm %ds", minutes, secs)
	end
	return string.format("%ds", secs)
end

function Format.percent(fraction: number, places: number?): string
	return string.format("%." .. (places or 1) .. "f%%", fraction * 100)
end

--[[
	"#025" -- the dex-number badge on an index tile.
]]
function Format.dex(id: number): string
	return string.format("#%03d", id)
end

return Format
