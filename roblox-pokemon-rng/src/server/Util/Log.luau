--!nonstrict
--[[
	Log
	Prefixed logging so PokeRNG output is greppable in a live server's console,
	and so debug spam can be turned off in one place.
]]

local Log = {}

Log.debugEnabled = false

local function stamp(level: string, scope: string, message: string): string
	return string.format("[PokeRNG/%s] %s: %s", scope, level, message)
end

function Log.info(scope: string, message: string, ...)
	print(stamp("info", scope, string.format(message, ...)))
end

function Log.warn(scope: string, message: string, ...)
	warn(stamp("warn", scope, string.format(message, ...)))
end

function Log.debug(scope: string, message: string, ...)
	if Log.debugEnabled then
		print(stamp("debug", scope, string.format(message, ...)))
	end
end

return Log
