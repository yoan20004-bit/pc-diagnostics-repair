--!nonstrict
--[[
	Signal
	A minimal event object for server-side service-to-service messaging, so
	services don't have to hold direct references to each other.

	Handlers run in their own thread -- one erroring listener can't stop the rest
	from firing, and a listener that yields can't stall the caller.
]]

local Signal = {}
Signal.__index = Signal

export type Connection = {
	Disconnect: (self: Connection) -> (),
	Connected: boolean,
}

function Signal.new()
	return setmetatable({ _handlers = {} }, Signal)
end

function Signal:Connect(handler: (...any) -> ())
	local connection
	connection = {
		Connected = true,
		Disconnect = function()
			if not connection.Connected then
				return
			end
			connection.Connected = false
			local index = table.find(self._handlers, connection)
			if index then
				table.remove(self._handlers, index)
			end
		end,
	}
	connection._handler = handler
	table.insert(self._handlers, connection)
	return connection
end

function Signal:Once(handler: (...any) -> ())
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		handler(...)
	end)
	return connection
end

function Signal:Fire(...)
	-- Iterate a copy: a handler is allowed to disconnect itself or others.
	local snapshot = table.clone(self._handlers)
	for _, connection in snapshot do
		if connection.Connected then
			task.spawn(connection._handler, ...)
		end
	end
end

function Signal:DisconnectAll()
	for _, connection in table.clone(self._handlers) do
		connection:Disconnect()
	end
	table.clear(self._handlers)
end

return Signal
